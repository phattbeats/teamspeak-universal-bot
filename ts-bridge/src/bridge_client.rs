//! bridge_client — the bridge's side of the Sexton IPC.
//!
//! **PHA-3341 split.** The bridge used to own its own `tsclientlib`
//! connection and run a full event loop over `con.events()`. It now dials
//! the Sexton's Unix-domain socket (a Docker-shared volume at
//! `/run/sexton/bridge.sock`) and consumes a much smaller protocol:
//!
//! - inbound (`Sexton -> bridge`): `BridgeEvent` (one of `SpeakerAudio`,
//!   `SpeakerStart`, `SpeakerStop`, `Roster`, `TextMessage`, `State`).
//! - outbound (`bridge -> Sexton`): `BridgeCommand` (voice/music audio,
//!   `Join`, `Poke`, `SendText`, `Mute`, `SayText`, `ClearVoice`,
//!   `MusicGain`).
//!
//! The shape of the wire protocol mirrors the bridge's public WebSocket
//! protocol (`protocol.rs`) 1:1 — same type bytes, same JSON header
//! shapes — so the bridge's WS server forwards without re-encoding.
//!
//! ## Failure model
//!
//! The bridge is a *client* of the Sexton's IPC. If the Sexton dies, the
//! bridge reconnects with exponential backoff capped at 60 s (same shape
//! as the bridge's old TS reconnect loop). The mixer outlives the
//! connection attempt — `Mixer::set_human_speaking(false)` on disconnect,
//! just like PHA-3216 taught us.
//!
//! The bridge does NOT reconnect to the TS server directly; the Sexton
//! owns the connection, the Sexton reconnects to TS. This is the whole
//! point of the refactor.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context as _, Result};
use log::{error, info, warn};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{broadcast, mpsc, Mutex};

use bridge_proto::{
    codec::{decode_frame, encode_frame, FrameType},
    events::{BridgeCommand, BridgeEvent, Snapshot},
    handshake::{Hello, HelloAck},
    DEFAULT_SOCKET_PATH, SOCKET_READY_POLL_MS,
};

/// How long the bridge waits between socket-appears checks on first
/// dial. Short — compose `depends_on: service_healthy` is supposed to
/// have already waited.
const SOCKET_POLL_INITIAL: Duration = Duration::from_millis(SOCKET_READY_POLL_MS);
/// Cap on the socket-appears poll interval.
const SOCKET_POLL_MAX: Duration = Duration::from_secs(5);
/// Cap on the per-attempt backoff after a dropped connection.
const RECONNECT_BACKOFF_MAX: Duration = Duration::from_secs(60);

/// Configuration for the bridge's IPC client. Only the socket path comes
/// from the environment (the WS bind and the rest of the bridge config
/// belong to `ws_server`).
#[derive(Debug, Clone)]
pub struct IpcConfig {
    pub socket_path: PathBuf,
    /// Bridge-side WS bind address, sent back to the Sexton in
    /// `HelloAck` so the Sexton can include it in the closing evidence
    /// table (PHA-2501).
    pub ws_bind: String,
}

impl IpcConfig {
    pub fn from_env() -> Result<Self> {
        let socket_path = std::env::var("SEXTON_BRIDGE_SOCKET")
            .unwrap_or_else(|_| DEFAULT_SOCKET_PATH.to_string());
        let ws_bind = std::env::var("WS_BIND")
            .unwrap_or_else(|_| "0.0.0.0:9099".to_string());
        Ok(Self {
            socket_path: PathBuf::from(socket_path),
            ws_bind,
        })
    }
}

/// One connected bridge session. The bridge keeps an instance per
/// `connect`/`reconnect` cycle — when the Sexton closes the socket
/// (restart, crash, container race) the bridge spawns a new one.
///
/// Owns the bidirectional stream to the Sexton and exposes a
/// `mpsc::Sender<BridgeCommand>` for outbound commands and a
/// `broadcast::Receiver<BridgeEvent>` for inbound events. The Sexton
/// fans out events to every connected bridge; commands are serialized
/// through the bridge's own writer so they can't interleave on the
/// stream.
pub struct BridgeSession {
    pub commands: mpsc::UnboundedSender<BridgeCommand>,
    pub events: broadcast::Receiver<BridgeEvent>,
}

/// The bridge-side IPC task. Replaces the old `ts_client::run` entirely.
///
/// Spawned by `main` and supervised by the same reconnect loop the old
/// TS connection used. Returns when the stream ends (clean disconnect)
/// or errors out; the loop reconnects after backoff.
///
/// `cmd_rx` is an `Arc<Mutex<>>` over the half of the mpsc `main`
/// owns — shared by reference so the reconnect loop never needs to
/// move it. The `ws_server`'s `cmd_tx.clone()` outlives every attempt
/// by design: while the IPC task is alive it serializes commands onto
/// the Sexton socket; while it is down, `cmd_tx.send()` errors and the
/// WS layer already knows (via the prior `State { connected: false }`)
/// the link is dark.
pub async fn run(
    config: &IpcConfig,
    cmd_rx: Arc<Mutex<mpsc::UnboundedReceiver<BridgeCommand>>>,
    event_tx: broadcast::Sender<BridgeEvent>,
    snapshot: Arc<Mutex<Snapshot>>,
) -> Result<()> {
    let stream = dial_with_backoff(&config.socket_path).await?;
    let (read, write) = stream.into_split();
    let mut read = read;
    let write = Arc::new(tokio::sync::Mutex::new(write));

    // 1) Hello from Sexton → HelloAck from us.
    let hello = read_hello(&mut read).await?;
    info!(
        "bridge connected to sexton v{}: channel={} state={:?} roster={} entries",
        hello.version,
        hello.watched_channel,
        hello.state,
        hello.roster.len()
    );

    // Seed the snapshot so the WS server can replay state+roster on
    // connect without waiting for the next server-sent event.
    {
        let mut s = snapshot.lock().await;
        s.apply_state(&hello.state);
        s.apply_roster(&hello.roster);
    }

    let ack = HelloAck {
        version: hello.version,
        ws_bind: config.ws_bind.clone(),
    };
    let frame = encode_frame(
        FrameType::HelloAck,
        &ack,
        &[],
    );
    {
        let mut w = write.lock().await;
        w.write_all(&frame).await.context("write hello-ack")?;
    }

    // 2) Inbound reader task: decode frames, fan out to broadcast.
    let event_tx_clone = event_tx.clone();
    let reader_handle = tokio::spawn(async move {
        if let Err(e) = read_loop(read, event_tx_clone).await {
            error!("bridge ipc read loop ended: {e}");
        }
    });

    // 3) Outbound writer task: pull from mpsc, serialize to stream.
    let writer_handle = tokio::spawn(async move {
        if let Err(e) = write_loop(cmd_rx, write).await {
            error!("bridge ipc write loop ended: {e}");
        }
    });

    // 4) Wait for either side to finish — the other will get a clean
    // error when the stream closes.
    tokio::select! {
        _ = reader_handle => {},
        _ = writer_handle => {},
    }

    // 5) Emit State::disconnected so the mixer releases the duck
    // envelope (PHA-3216 / PHA-3174 standing requirement). Use the
    // Sexton's last-known state shape but flip `connected: false` and
    // clear identifiers.
    let _ = event_tx.send(BridgeEvent::State(bridge_proto::StateSnapshot {
        connected: false,
        channel_id: 0,
        channel_name: String::new(),
        own_client_id: None,
    }));
    {
        let mut s = snapshot.lock().await;
        s.set_disconnected();
    }

    Ok(())
}

/// Wait for the socket to exist (the Sexton may still be starting under
/// `depends_on`) then dial it. Backs off up to `SOCKET_POLL_MAX` so the
/// loop is responsive on normal boot and steady under load.
async fn dial_with_backoff(path: &Path) -> Result<tokio::net::UnixStream> {
    let mut interval = SOCKET_POLL_INITIAL;
    loop {
        match tokio::net::UnixStream::connect(path).await {
            Ok(s) => return Ok(s),
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound {
                    warn!(
                        "sexton socket {} not present yet; retrying in {:?}",
                        path.display(),
                        interval
                    );
                    tokio::time::sleep(interval).await;
                    interval = std::cmp::min(interval * 2, SOCKET_POLL_MAX);
                    continue;
                }
                return Err(anyhow!("dial {}: {}", path.display(), e));
            }
        }
    }
}

/// Read the Sexton's `Hello` frame. We don't trust a missing `Hello`
/// (it could be a stale fd that already lost its first frame) — the
/// caller reconnects after backoff.
async fn read_hello(read: &mut OwnedReadHalf) -> Result<Hello> {
    let mut buf = Vec::new();
    let hello: Hello = loop {
        let chunk = read
            .read_u8()
            .await
            .map_err(|e| anyhow!("reading hello: {e}"))?;
        buf.push(chunk);
        if let Ok((frame, _consumed)) = decode_frame(&buf) {
            if frame.msg_type != FrameType::Hello {
                return Err(anyhow!(
                    "expected Hello frame (0xF0), got 0x{:02x}",
                    frame.msg_type as u8
                ));
            }
            let hello: Hello = serde_json::from_value(frame.header)
                .map_err(|e| anyhow!("hello header decode: {e}"))?;
            break hello;
        }
    };
    Ok(hello)
}

async fn read_loop(
    mut read: OwnedReadHalf,
    event_tx: broadcast::Sender<BridgeEvent>,
) -> Result<()> {
    // Bounded read buffer; we parse one frame at a time.
    let mut buf = vec![0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let n = read.read(&mut buf).await.context("read ipc")?;
        if n == 0 {
            return Err(anyhow!("sexton closed the ipc socket"));
        }
        pending.extend_from_slice(&buf[..n]);
        loop {
            match decode_frame(&pending) {
                Ok((frame, consumed)) => {
                    let event = bridge_event_from_frame(frame)?;
                    let _ = event_tx.send(event);
                    pending.drain(..consumed);
                }
                Err(bridge_proto::codec::FrameError::TooShort) => break,
                Err(e) => {
                    return Err(anyhow!("decode ipc frame: {e}"));
                }
            }
        }
    }
}

async fn write_loop(
    cmd_rx: Arc<Mutex<mpsc::UnboundedReceiver<BridgeCommand>>>,
    write: Arc<Mutex<OwnedWriteHalf>>,
) -> Result<()> {
    loop {
        let cmd = {
            let mut rx = cmd_rx.lock().await;
            rx.recv().await
        };
        let cmd = match cmd {
            Some(c) => c,
            None => return Ok(()),
        };
        let (frame_type, header, payload) = bridge_command_to_frame(cmd)?;
        let frame = encode_frame(frame_type, &header, &payload);
        let mut w = write.lock().await;
        if let Err(e) = w.write_all(&frame).await {
            return Err(anyhow!("write ipc: {e}"));
        }
    }
}

fn bridge_event_from_frame(frame: bridge_proto::RawFrame) -> Result<BridgeEvent> {
    match frame.msg_type {
        FrameType::SpeakerAudio => {
            #[derive(serde::Deserialize)]
            struct H {
                #[serde(rename = "clientId")]
                client_id: u16,
                nickname: String,
                seq: u32,
            }
            let h: H = serde_json::from_value(frame.header)?;
            let pcm = crate::protocol::pcm16_to_samples(&frame.payload);
            Ok(BridgeEvent::SpeakerAudio {
                client_id: h.client_id,
                nickname: h.nickname,
                seq: h.seq,
                pcm,
            })
        }
        FrameType::SpeakerStart => {
            #[derive(serde::Deserialize)]
            struct H {
                #[serde(rename = "clientId")]
                client_id: u16,
            }
            let h: H = serde_json::from_value(frame.header)?;
            Ok(BridgeEvent::SpeakerStart { client_id: h.client_id })
        }
        FrameType::SpeakerStop => {
            #[derive(serde::Deserialize)]
            struct H {
                #[serde(rename = "clientId")]
                client_id: u16,
            }
            let h: H = serde_json::from_value(frame.header)?;
            Ok(BridgeEvent::SpeakerStop { client_id: h.client_id })
        }
        FrameType::Roster => {
            let roster: Vec<bridge_proto::RosterEntry> = serde_json::from_value(frame.header)?;
            Ok(BridgeEvent::Roster(roster))
        }
        FrameType::TextMessage => {
            #[derive(serde::Deserialize)]
            struct H {
                #[serde(rename = "clientId")]
                client_id: u16,
                nickname: String,
                text: String,
                target: String,
            }
            let h: H = serde_json::from_value(frame.header)?;
            // Target is one of four values; reject anything else at the
            // bridge boundary so the WS layer never has to defend
            // against a malformed string that would corrupt its binary
            // frame header layout.
            let target: &'static str = match h.target.as_str() {
                "channel" => "channel",
                "server" => "server",
                "client" => "client",
                "poke" => "poke",
                other => return Err(anyhow!("unknown text target: {other:?}")),
            };
            Ok(BridgeEvent::TextMessage {
                client_id: h.client_id,
                nickname: h.nickname,
                text: h.text,
                target,
            })
        }
        FrameType::State => {
            let state: bridge_proto::StateSnapshot = serde_json::from_value(frame.header)?;
            Ok(BridgeEvent::State(state))
        }
        other => Err(anyhow!("unexpected bridge frame type 0x{:02x}", other as u8)),
    }
}

fn bridge_command_to_frame(
    cmd: BridgeCommand,
) -> Result<(FrameType, serde_json::Value, Vec<u8>)> {
    match cmd {
        BridgeCommand::VoiceAudio { samples } => {
            let payload = crate::protocol::samples_to_pcm16(&samples);
            let header = serde_json::json!({ "count": samples.len() });
            Ok((FrameType::VoiceAudio, header, payload))
        }
        BridgeCommand::MusicAudio { samples } => {
            let payload = crate::protocol::samples_to_pcm16(&samples);
            let header = serde_json::json!({ "count": samples.len() });
            Ok((FrameType::MusicAudio, header, payload))
        }
        BridgeCommand::MusicGain { gain } => Ok((
            FrameType::MusicGain,
            serde_json::json!({ "gain": gain }),
            Vec::new(),
        )),
        BridgeCommand::ClearVoice => Ok((FrameType::ClearVoice, serde_json::json!({}), Vec::new())),
        BridgeCommand::SayText { text } => Ok((
            FrameType::SayText,
            serde_json::json!({ "text": text }),
            Vec::new(),
        )),
        BridgeCommand::Join { channel } => Ok((
            FrameType::Join,
            serde_json::json!({ "channel": channel }),
            Vec::new(),
        )),
        BridgeCommand::Mute { muted } => Ok((
            FrameType::Mute,
            serde_json::json!({ "muted": muted }),
            Vec::new(),
        )),
        BridgeCommand::Poke { client_id, text } => Ok((
            FrameType::Poke,
            serde_json::json!({ "clientId": client_id, "text": text }),
            Vec::new(),
        )),
        BridgeCommand::SendText { target, text } => {
            let target_json = serde_json::to_value(&target)?;
            Ok((
                FrameType::SendText,
                serde_json::json!({ "target": target_json, "text": text }),
                Vec::new(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trips_pcm_audio() {
        let pcm: Vec<i16> = (0..960).map(|i| (i as i16).wrapping_mul(37)).collect();
        let payload = crate::protocol::samples_to_pcm16(&pcm);
        let frame = encode_frame(
            FrameType::SpeakerAudio,
            &serde_json::json!({"clientId": 1, "nickname": "x", "seq": 0}),
            &payload,
        );
        let (decoded, _) = decode_frame(&frame).unwrap();
        assert_eq!(decoded.msg_type, FrameType::SpeakerAudio);
        assert_eq!(
            crate::protocol::pcm16_to_samples(&decoded.payload),
            pcm
        );
    }
}