//! Local WebSocket server. One or more clients (the realtime voice runtime,
//! `bridge-test`, …) connect here — never expose this port outside the
//! compose network.
//!
//! **#3341** moved this file's events off an in-process `ts_client::run`
//! and onto a Unix-socket IPC client (`bridge_client.rs`) dialing a
//! separate `ts-bridge` container, because two processes each held their
//! own `tsclientlib::Connection` under two different bot identities and
//! Brandon flagged the double roster entry.
//!
//! **#3342** removes the second process entirely — "one docker
//! container / one bot account" (Brandon, #3342) — so this server now
//! runs inside the Sexton binary and gets its events straight from the
//! Sexton's own connection event loop (`audio.rs`) over the same
//! `broadcast`/`mpsc` channel shapes `bridge_client.rs` used to bridge
//! across the socket. The WS server itself, and the wire protocol it
//! speaks to external clients, are unchanged: `encode_event` still maps
//! `bridge_proto::BridgeEvent` to the exact same frame bytes.
//!
//! Not implemented: the Unix-socket IPC layer bridge-proto's `codec`/
//! `handshake` modules describe. With no second process left to dial it,
//! adding a self-dial loopback socket inside one binary would be an extra
//! moving part (accept loop, framing, reconnect/backoff) that buys nothing
//! — the broadcast/mpsc channels below already are the in-process version
//! of the exact same fan-out. See the PR description for the fuller
//! reasoning; `bridge-proto`'s `codec.rs`/`handshake.rs` stay in the
//! workspace, tested, in case a future split needs them again.

use std::net::SocketAddr;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

use bridge_proto::{
    events::{BridgeCommand, BridgeEvent, SendTarget, Snapshot},
    StateSnapshot,
};

use crate::mixer::Mixer;
use crate::protocol::{self, *};

pub async fn run(
    bind: SocketAddr,
    mixer: std::sync::Arc<tokio::sync::Mutex<Mixer>>,
    cmd_tx: mpsc::UnboundedSender<BridgeCommand>,
    event_tx: broadcast::Sender<BridgeEvent>,
    tts_webhook_url: Option<String>,
    snapshot: std::sync::Arc<tokio::sync::Mutex<Snapshot>>,
) -> anyhow::Result<()> {
    let listener = TcpListener::bind(bind).await?;
    info!("sexton audio bridge websocket listening on {bind}");

    loop {
        let (stream, peer) = listener.accept().await?;
        let mixer = mixer.clone();
        let cmd_tx = cmd_tx.clone();
        // Subscribe *before* reading the snapshot below: a change landing in
        // between then costs the client a duplicate frame, whereas the other
        // order would lose the update entirely.
        let event_rx = event_tx.subscribe();
        let tts = tts_webhook_url.clone();
        let snapshot = snapshot.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(stream, mixer, cmd_tx, event_rx, tts, snapshot).await {
                info!("ws client {peer} disconnected: {e}");
            }
        });
    }
}

async fn handle_conn(
    stream: tokio::net::TcpStream,
    mixer: std::sync::Arc<tokio::sync::Mutex<Mixer>>,
    cmd_tx: mpsc::UnboundedSender<BridgeCommand>,
    mut event_rx: broadcast::Receiver<BridgeEvent>,
    tts_webhook_url: Option<String>,
    snapshot: std::sync::Arc<tokio::sync::Mutex<Snapshot>>,
) -> anyhow::Result<()> {
    let ws = tokio_tungstenite::accept_async(stream).await?;
    let (mut sink, mut source) = ws.split();

    // PROTOCOL.md: a client gets the current `state` and `roster` on connect.
    // Both are broadcast only on change, so without this a client joining a
    // settled bridge learns nothing until the next join/leave.
    let initial = snapshot.lock().await.events();

    let writer = tokio::spawn(async move {
        for ev in initial {
            if sink.send(Message::Binary(encode_event(&ev))).await.is_err() {
                return;
            }
        }
        loop {
            let ev = match event_rx.recv().await {
                Ok(ev) => ev,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            };
            let frame = encode_event(&ev);
            if sink.send(Message::Binary(frame)).await.is_err() {
                break;
            }
        }
    });

    let mut audio_frames: u64 = 0;
    while let Some(msg) = source.next().await {
        let msg = msg?;
        let bytes = match msg {
            Message::Binary(b) => b,
            Message::Close(_) => break,
            _ => continue,
        };
        let frame = match protocol::decode_frame(&bytes) {
            Ok(f) => f,
            Err(e) => {
                warn!("bad frame from client: {e}");
                continue;
            }
        };
        // 1 Hz inbound telemetry, the counterpart to the send tick's: says
        // whether audio is arriving from the client at all (#3216).
        if matches!(frame.msg_type, TYPE_VOICE_AUDIO | TYPE_MUSIC_AUDIO) {
            audio_frames += 1;
            if audio_frames % 50 == 0 {
                debug!(
                    "inbound audio: {audio_frames} frames so far, last type=0x{:02x} payload={} bytes",
                    frame.msg_type,
                    frame.payload.len()
                );
            }
        }
        dispatch(frame, &mixer, &cmd_tx, &tts_webhook_url).await;
    }

    writer.abort();
    Ok(())
}

async fn dispatch(
    frame: RawFrame,
    mixer: &std::sync::Arc<tokio::sync::Mutex<Mixer>>,
    cmd_tx: &mpsc::UnboundedSender<BridgeCommand>,
    tts_webhook_url: &Option<String>,
) {
    match frame.msg_type {
        TYPE_VOICE_AUDIO => {
            let samples = pcm16_to_samples(&frame.payload);
            mixer.lock().await.push_voice(&samples);
        }
        TYPE_MUSIC_AUDIO => {
            let samples = pcm16_to_samples(&frame.payload);
            mixer.lock().await.push_music(&samples);
        }
        TYPE_MUSIC_GAIN => {
            if let Ok(h) = serde_json::from_value::<MusicGainHeader>(frame.header) {
                mixer.lock().await.set_music_gain(h.gain);
            }
        }
        TYPE_CLEAR_VOICE => {
            mixer.lock().await.clear_voice();
        }
        TYPE_SAY_TEXT => {
            if let Ok(h) = serde_json::from_value::<SayTextHeader>(frame.header) {
                match tts_webhook_url {
                    Some(url) => warn!(
                        "say_text received (\"{}\") but the TTS webhook client isn't wired up yet \
                         (configured URL: {url}) — push voice_audio directly for now",
                        h.text
                    ),
                    None => warn!(
                        "say_text received (\"{}\") but --tts-webhook-url is not configured — \
                         push voice_audio directly for now",
                        h.text
                    ),
                }
            }
        }
        TYPE_JOIN => {
            if let Ok(h) = serde_json::from_value::<JoinHeader>(frame.header) {
                let _ = cmd_tx.send(BridgeCommand::Join { channel: h.channel });
            }
        }
        TYPE_MUTE => {
            if let Ok(h) = serde_json::from_value::<MuteHeader>(frame.header) {
                let _ = cmd_tx.send(BridgeCommand::Mute { muted: h.muted });
            }
        }
        TYPE_POKE => {
            if let Ok(h) = serde_json::from_value::<PokeHeader>(frame.header) {
                let _ = cmd_tx.send(BridgeCommand::Poke { client_id: h.client_id, text: h.text });
            }
        }
        TYPE_SEND_TEXT => {
            if let Ok(h) = serde_json::from_value::<SendTextHeader>(frame.header) {
                let target = match &h.target {
                    serde_json::Value::String(s) if s == "channel" => Some(SendTarget::Channel),
                    serde_json::Value::String(s) if s == "server" => Some(SendTarget::Server),
                    serde_json::Value::String(s) => s.parse::<u16>().ok().map(|id| SendTarget::Client { id }),
                    serde_json::Value::Number(n) => n.as_u64().map(|v| SendTarget::Client { id: v as u16 }),
                    _ => None,
                };
                if let Some(target) = target {
                    let _ = cmd_tx.send(BridgeCommand::SendText { target, text: h.text });
                } else {
                    warn!("send_text: unrecognized target {:?}", h.target);
                }
            }
        }
        // --- moderation (#3786) ------------------------------------------
        TYPE_CLIENT_KICK => {
            if let Ok(h) = serde_json::from_value::<ClientKickHeader>(frame.header) {
                let _ = cmd_tx.send(BridgeCommand::ClientKick {
                    client_id: h.client_id,
                    from_server: h.from_server,
                    reason: h.reason,
                });
            }
        }
        TYPE_BAN_CLIENT => {
            if let Ok(h) = serde_json::from_value::<BanClientHeader>(frame.header) {
                let _ = cmd_tx.send(BridgeCommand::BanClient {
                    client_id: h.client_id,
                    duration_secs: h.duration_secs,
                    reason: h.reason,
                });
            }
        }
        TYPE_BAN_DEL => {
            if let Ok(h) = serde_json::from_value::<BanDelHeader>(frame.header) {
                let _ = cmd_tx.send(BridgeCommand::BanDel { ban_id: h.ban_id });
            }
        }
        TYPE_BAN_LIST => {
            let _ = cmd_tx.send(BridgeCommand::BanList);
        }
        TYPE_CLIENT_MOVE => {
            if let Ok(h) = serde_json::from_value::<ClientMoveHeader>(frame.header) {
                let _ = cmd_tx
                    .send(BridgeCommand::ClientMove { client_id: h.client_id, channel_id: h.channel_id });
            }
        }
        TYPE_CLIENT_EDIT_MUTE => {
            if let Ok(h) = serde_json::from_value::<ClientEditMuteHeader>(frame.header) {
                let _ = cmd_tx.send(BridgeCommand::ClientEditMute { client_id: h.client_id, muted: h.muted });
            }
        }
        TYPE_CHANNEL_EDIT => {
            if let Ok(h) = serde_json::from_value::<ChannelEditHeader>(frame.header) {
                let _ = cmd_tx.send(BridgeCommand::ChannelEdit {
                    channel_id: h.channel_id,
                    name: h.name,
                    topic: h.topic,
                });
            }
        }
        TYPE_CHANNEL_CREATE => {
            if let Ok(h) = serde_json::from_value::<ChannelCreateHeader>(frame.header) {
                let _ = cmd_tx.send(BridgeCommand::ChannelCreate { name: h.name, parent_id: h.parent_id });
            }
        }
        TYPE_CHANNEL_DELETE => {
            if let Ok(h) = serde_json::from_value::<ChannelDeleteHeader>(frame.header) {
                let _ =
                    cmd_tx.send(BridgeCommand::ChannelDelete { channel_id: h.channel_id, force: h.force });
            }
        }
        TYPE_SERVER_EDIT => {
            if let Ok(h) = serde_json::from_value::<ServerEditHeader>(frame.header) {
                let _ =
                    cmd_tx.send(BridgeCommand::ServerEdit { name: h.name, welcome_message: h.welcome_message });
            }
        }
        TYPE_SERVER_GROUP_ADD_CLIENT => {
            if let Ok(h) = serde_json::from_value::<ServerGroupAddClientHeader>(frame.header) {
                let _ = cmd_tx.send(BridgeCommand::ServerGroupAddClient {
                    server_group_id: h.server_group_id,
                    client_id: h.client_id,
                });
            }
        }
        TYPE_LIST_CHANNELS => {
            let _ = cmd_tx.send(BridgeCommand::ListChannels);
        }
        TYPE_SET_DESCRIPTION => {
            if let Ok(h) = serde_json::from_value::<SetDescriptionHeader>(frame.header) {
                let _ = cmd_tx.send(BridgeCommand::SetDescription { description: h.description });
            }
        }
        other => debug!("unknown inbound frame type 0x{other:02x}, ignoring"),
    }
}

fn encode_event(ev: &BridgeEvent) -> Vec<u8> {
    match ev {
        BridgeEvent::SpeakerAudio { client_id, nickname, seq, pcm } => encode_frame(
            TYPE_SPEAKER_AUDIO,
            &SpeakerAudioHeader { client_id: *client_id, nickname: nickname.clone(), seq: *seq },
            &samples_to_pcm16(pcm),
        ),
        BridgeEvent::SpeakerStart { client_id } => {
            encode_frame(TYPE_SPEAKER_START, &ClientIdHeader { client_id: *client_id }, &[])
        }
        BridgeEvent::SpeakerStop { client_id } => {
            encode_frame(TYPE_SPEAKER_STOP, &ClientIdHeader { client_id: *client_id }, &[])
        }
        BridgeEvent::Roster(entries) => encode_frame(TYPE_ROSTER, entries, &[]),
        BridgeEvent::TextMessage { client_id, nickname, text, target } => encode_frame(
            TYPE_TEXT_MESSAGE,
            &TextMessageHeader {
                client_id: *client_id,
                nickname: nickname.clone(),
                text: text.clone(),
                target,
            },
            &[],
        ),
        BridgeEvent::State(StateSnapshot { connected, channel_id, channel_name, own_client_id }) => {
            encode_frame(
                TYPE_STATE,
                &StateHeader {
                    connected: *connected,
                    channel_id: *channel_id,
                    channel_name: channel_name.clone(),
                    own_client_id: *own_client_id,
                },
                &[],
            )
        }
        BridgeEvent::ModerationResult { action, ok, detail } => encode_frame(
            TYPE_MODERATION_RESULT,
            &ModerationResultHeader { action, ok: *ok, detail: detail.clone() },
            &[],
        ),
        BridgeEvent::ChannelTree(tree) => encode_frame(TYPE_CHANNEL_TREE, tree, &[]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_proto::events::RosterEntry;

    /// A client connecting to a settled bridge is owed the current state and
    /// roster, not silence until the next join/leave.
    #[tokio::test]
    async fn snapshot_yields_state_then_roster() {
        let snap = Snapshot {
            connected: true,
            channel_id: 7,
            channel_name: "General Shit".into(),
            own_client_id: Some(11),
            roster: vec![
                RosterEntry {
                    client_id: 11,
                    nickname: "Sexton".into(),
                    muted: false,
                    away: false,
                    server_groups: vec![],
                },
                RosterEntry {
                    client_id: 42,
                    nickname: "brandon".into(),
                    muted: false,
                    away: false,
                    server_groups: vec![],
                },
            ],
        };

        let frames: Vec<Vec<u8>> = snap.events().iter().map(encode_event).collect();
        assert_eq!(frames.len(), 2);

        let state = protocol::decode_frame(&frames[0]).expect("state frame decodes");
        assert_eq!(state.msg_type, TYPE_STATE);
        assert_eq!(state.header["connected"], serde_json::json!(true));
        assert_eq!(state.header["channelId"], serde_json::json!(7));
        assert_eq!(state.header["channelName"], serde_json::json!("General Shit"));
        assert_eq!(state.header["ownClientId"], serde_json::json!(11));

        let roster = protocol::decode_frame(&frames[1]).expect("roster frame decodes");
        assert_eq!(roster.msg_type, TYPE_ROSTER);
        assert_eq!(roster.header[0]["clientId"], serde_json::json!(11));
        assert_eq!(roster.header[1]["clientId"], serde_json::json!(42));
        assert_eq!(roster.header[1]["nickname"], serde_json::json!("brandon"));
    }

    /// Before the first successful connect there is nothing to report, but the
    /// client still gets a frame saying so rather than an open socket that
    /// never speaks.
    #[tokio::test]
    async fn default_snapshot_reports_disconnected() {
        let frames: Vec<Vec<u8>> = Snapshot::default().events().iter().map(encode_event).collect();
        let state = protocol::decode_frame(&frames[0]).expect("state frame decodes");
        assert_eq!(state.msg_type, TYPE_STATE);
        assert_eq!(state.header["connected"], serde_json::json!(false));
        assert!(state.header.get("ownClientId").is_none());

        let roster = protocol::decode_frame(&frames[1]).expect("roster frame decodes");
        assert_eq!(roster.msg_type, TYPE_ROSTER);
        assert_eq!(roster.header, serde_json::json!([]));
    }
}
