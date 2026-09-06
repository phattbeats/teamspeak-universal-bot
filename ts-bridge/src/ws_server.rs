//! Local WebSocket server. One or more clients (the realtime voice runtime,
//! `bridge-test`, …) connect here — never expose this port outside the
//! compose network.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::Message;

use crate::mixer::Mixer;
use crate::protocol::{self, *};
use crate::ts_client::{BridgeCommand, BridgeEvent, SendTarget};

pub async fn run(
    bind: SocketAddr,
    mixer: Arc<Mutex<Mixer>>,
    cmd_tx: mpsc::UnboundedSender<BridgeCommand>,
    event_tx: broadcast::Sender<BridgeEvent>,
    tts_webhook_url: Option<String>,
) -> anyhow::Result<()> {
    let listener = TcpListener::bind(bind).await?;
    log::info!("ts-bridge websocket listening on {bind}");

    loop {
        let (stream, peer) = listener.accept().await?;
        let mixer = mixer.clone();
        let cmd_tx = cmd_tx.clone();
        let event_rx = event_tx.subscribe();
        let tts = tts_webhook_url.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(stream, mixer, cmd_tx, event_rx, tts).await {
                log::info!("ws client {peer} disconnected: {e}");
            }
        });
    }
}

async fn handle_conn(
    stream: tokio::net::TcpStream,
    mixer: Arc<Mutex<Mixer>>,
    cmd_tx: mpsc::UnboundedSender<BridgeCommand>,
    mut event_rx: broadcast::Receiver<BridgeEvent>,
    tts_webhook_url: Option<String>,
) -> anyhow::Result<()> {
    let ws = tokio_tungstenite::accept_async(stream).await?;
    let (mut sink, mut source) = ws.split();

    let writer = tokio::spawn(async move {
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
                log::warn!("bad frame from client: {e}");
                continue;
            }
        };
        dispatch(frame, &mixer, &cmd_tx, &tts_webhook_url);
    }

    writer.abort();
    Ok(())
}

fn dispatch(
    frame: RawFrame,
    mixer: &Arc<Mutex<Mixer>>,
    cmd_tx: &mpsc::UnboundedSender<BridgeCommand>,
    tts_webhook_url: &Option<String>,
) {
    match frame.msg_type {
        TYPE_VOICE_AUDIO => {
            let samples = pcm16_to_samples(&frame.payload);
            mixer.lock().unwrap().push_voice(&samples);
        }
        TYPE_MUSIC_AUDIO => {
            let samples = pcm16_to_samples(&frame.payload);
            mixer.lock().unwrap().push_music(&samples);
        }
        TYPE_MUSIC_GAIN => {
            if let Ok(h) = serde_json::from_value::<MusicGainHeader>(frame.header) {
                mixer.lock().unwrap().set_music_gain(h.gain);
            }
        }
        TYPE_CLEAR_VOICE => {
            mixer.lock().unwrap().clear_voice();
        }
        TYPE_SAY_TEXT => {
            if let Ok(h) = serde_json::from_value::<SayTextHeader>(frame.header) {
                match tts_webhook_url {
                    Some(url) => log::warn!(
                        "say_text received (\"{}\") but the TTS webhook client isn't wired up yet \
                         (configured URL: {url}) — push voice_audio directly for now",
                        h.text
                    ),
                    None => log::warn!(
                        "say_text received (\"{}\") but TTS_WEBHOOK_URL is not configured — \
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
                    serde_json::Value::String(s) => s.parse::<u16>().ok().map(SendTarget::Client),
                    serde_json::Value::Number(n) => n.as_u64().map(|v| SendTarget::Client(v as u16)),
                    _ => None,
                };
                if let Some(target) = target {
                    let _ = cmd_tx.send(BridgeCommand::SendText { target, text: h.text });
                } else {
                    log::warn!("send_text: unrecognized target {:?}", h.target);
                }
            }
        }
        other => log::debug!("unknown inbound frame type 0x{other:02x}, ignoring"),
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
        BridgeEvent::State { connected, channel_id, channel_name } => encode_frame(
            TYPE_STATE,
            &StateHeader { connected: *connected, channel_id: *channel_id, channel_name: channel_name.clone() },
            &[],
        ),
    }
}
