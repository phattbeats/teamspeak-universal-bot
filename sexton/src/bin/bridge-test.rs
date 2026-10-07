//! Manual verification client for #3174's acceptance test.
//!
//! Connects to a running Sexton, plays a continuous 220 Hz tone into
//! `music_audio` and 2 s bursts of a 440 Hz tone into `voice_audio` every
//! 4 s, and logs every frame it receives back (`speaker_audio`, `roster`,
//! `state`, `text_message`) so a human (or a second voicespike-based
//! listener sitting in the same TS channel) can confirm:
//!   (a) both tones are audible in the channel,
//!   (b) the 220 Hz tone drops by ~12 dB while the 440 Hz tone plays,
//!   (c) per-speaker frames from a real talker arrive tagged with its
//!       clientId.
//!
//! This tool only drives the WebSocket side — (a) and (b) require an actual
//! TS6 server and a second client actually listening in-channel, which this
//! sandbox has no network path to.
//!
//! #3342: this used to dial a standalone `ts-bridge` container; the WS
//! server it drives now lives inside the Sexton binary, same port, same
//! wire format (`ts-bridge/PROTOCOL.md` moved to `sexton/PROTOCOL.md`
//! unchanged). Nothing about this tool's own protocol handling needed to
//! change — it only ever spoke WebSocket, never tsclientlib directly.
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
    let mut args = std::env::args().skip(1);
    let url = args.next().unwrap_or_else(|| "ws://127.0.0.1:9099".to_string());
    let seconds: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(30);

    println!("connecting to {url}");
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
                0x01 => println!(
                    "speaker_audio clientId={} nickname={} seq={} bytes={}",
                    header["clientId"],
                    header["nickname"],
                    header["seq"],
                    bytes.len() - header_end
                ),
                0x02 => println!("speaker_start {header}"),
                0x03 => println!("speaker_stop {header}"),
                0x04 => println!("roster {header}"),
                0x05 => println!("text_message {header}"),
                0x06 => println!("state {header}"),
                other => println!("unknown out frame type 0x{other:02x} header={header}"),
            }
        }
    });

    // The 220 Hz music lane runs the whole time; the 440 Hz voice tone comes in
    // in bursts. Criterion (b) is a *comparison*, so the listener needs both a
    // quiet-voice window to measure un-ducked 220 Hz and a talking window to
    // measure the ducked level — playing voice continuously would duck the
    // music for the entire capture and leave nothing to compare against.
    // duckGain 0.25 == 20*log10(0.25) == -12.04 dB, the expected drop.
    const CYCLE_FRAMES: u64 = 200; // 4 s at 20 ms
    const VOICE_ON_FRAMES: u64 = 100; // second half of each cycle

    let mut tick = interval(Duration::from_millis(20));
    let mut voice_phase = 0f32;
    let mut music_phase = 0f32;
    let frames = seconds * 1000 / 20;
    let mut voice_was_on = false;
    for i in 0..frames {
        tick.tick().await;

        let voice_on = (i % CYCLE_FRAMES) >= (CYCLE_FRAMES - VOICE_ON_FRAMES);
        if voice_on != voice_was_on {
            voice_was_on = voice_on;
            println!(
                "t={:.1}s voice 440 Hz {} — expect 220 Hz music {}",
                i as f32 * 0.02,
                if voice_on { "ON" } else { "OFF" },
                if voice_on { "ducked ~-12 dB within 50 ms" } else { "recovering to full over 800 ms" }
            );
        }

        // Music is always sent so the un-ducked and ducked levels are directly
        // comparable across the two halves of the cycle.
        let music = tone_frame(220.0, &mut music_phase, 0.5);
        sink.send(Message::Binary(frame(0x82, &serde_json::json!({}), &pcm16(&music)))).await?;

        if voice_on {
            let voice = tone_frame(440.0, &mut voice_phase, 0.5);
            sink.send(Message::Binary(frame(0x81, &serde_json::json!({}), &pcm16(&voice)))).await?;
        }
    }

    println!("done sending tones; ctrl-c to stop listening");
    let _ = reader.await;
    Ok(())
}
