//! Manual verification client for PHA-3174's acceptance test.
//!
//! Connects to a running `ts-bridge`, plays a 440 Hz tone into `voice_audio`
//! and a 220 Hz tone into `music_audio`, and logs every frame it receives
//! back (`speaker_audio`, `roster`, `state`, `text_message`) so a human (or
//! a second voicespike-based listener sitting in the same TS channel) can
//! confirm:
//!   (a) both tones are audible in the channel,
//!   (b) the 220 Hz tone drops by ~12 dB while the 440 Hz tone plays,
//!   (c) per-speaker frames from a real talker arrive tagged with its
//!       clientId.
//!
//! This tool only drives the WebSocket side — (a) and (b) require an actual
//! TS6 server and a second client actually listening in-channel, which this
//! sandbox has no network path to. Run it against a live `ts-bridge`
//! deployment (e.g. `ws://ts-bridge:9099`).
//!
//!     cargo run --bin bridge-test -- ws://127.0.0.1:9099 30

use std::f32::consts::PI;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::time::interval;
use tokio_tungstenite::tungstenite::Message;

const SAMPLE_RATE: f32 = 48_000.0;
const FRAME_SAMPLES: usize = 960;

fn tone_frame(freq: f32, phase: &mut f32, amplitude: f32) -> Vec<i16> {
    let mut out = Vec::with_capacity(FRAME_SAMPLES);
    let step = 2.0 * PI * freq / SAMPLE_RATE;
    for _ in 0..FRAME_SAMPLES {
        out.push((phase.sin() * amplitude * i16::MAX as f32) as i16);
        *phase += step;
        if *phase > 2.0 * PI {
            *phase -= 2.0 * PI;
        }
    }
    out
}

fn frame(msg_type: u8, header: &serde_json::Value, payload: &[u8]) -> Vec<u8> {
    let header_bytes = serde_json::to_vec(header).unwrap();
    let mut out = Vec::with_capacity(5 + header_bytes.len() + payload.len());
    out.push(msg_type);
    out.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_bytes);
    out.extend_from_slice(payload);
    out
}

fn pcm16(samples: &[i16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let mut args = std::env::args().skip(1);
    let url = args.next().unwrap_or_else(|| "ws://127.0.0.1:9099".to_string());
    let seconds: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(30);

    log::info!("connecting to {url}");
    let (ws, _) = tokio_tungstenite::connect_async(&url).await?;
    let (mut sink, mut source) = ws.split();

    let reader = tokio::spawn(async move {
        while let Some(Ok(Message::Binary(bytes))) = source.next().await {
            if bytes.len() < 5 {
                continue;
            }
            let msg_type = bytes[0];
            let header_len = u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as usize;
            let header_end = (5 + header_len).min(bytes.len());
            let header: serde_json::Value =
                serde_json::from_slice(&bytes[5..header_end]).unwrap_or_default();
            match msg_type {
                0x01 => log::info!(
                    "speaker_audio clientId={} nickname={} seq={} bytes={}",
                    header["clientId"],
                    header["nickname"],
                    header["seq"],
                    bytes.len() - header_end
                ),
                0x02 => log::info!("speaker_start {header}"),
                0x03 => log::info!("speaker_stop {header}"),
                0x04 => log::info!("roster {header}"),
                0x05 => log::info!("text_message {header}"),
                0x06 => log::info!("state {header}"),
                other => log::info!("unknown out frame type 0x{other:02x} header={header}"),
            }
        }
    });

    let mut tick = interval(Duration::from_millis(20));
    let mut voice_phase = 0f32;
    let mut music_phase = 0f32;
    let frames = seconds * 1000 / 20;
    for _ in 0..frames {
        tick.tick().await;
        let voice = tone_frame(440.0, &mut voice_phase, 0.5);
        let music = tone_frame(220.0, &mut music_phase, 0.5);
        sink.send(Message::Binary(frame(0x81, &serde_json::json!({}), &pcm16(&voice)))).await?;
        sink.send(Message::Binary(frame(0x82, &serde_json::json!({}), &pcm16(&music)))).await?;
    }

    log::info!("done sending tones; ctrl-c to stop listening");
    let _ = reader.await;
    Ok(())
}
