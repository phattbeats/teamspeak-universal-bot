//! ts-bridge — audio sidecar for the Sexton.
//!
//! **PHA-3341 split.** Before this commit, the bridge owned its own
//! `tsclientlib::Connection` (nickname `Sexton-Bridge`, separate
//! identity from the text Sexton's `Sexton`). The channel roster on
//! `teamspeak.phatt.vip` showed two clients in the room.
//!
//! The bridge now dials a Unix-domain socket the Sexton binds on a
//! Docker-shared volume. The Sexton owns the `Connection`; the bridge
//! is a pure audio-side consumer: `BridgeEvent` in, `BridgeCommand`
//! out. The mixer, the WS server, and the public protocol are
//! unchanged.
//!
//! ## Failure model
//!
//! - The bridge *reconnects* to the Sexton's socket with exponential
//!   backoff (same shape as the old TS reconnect loop). The mixer
//!   outlives every attempt; on disconnect the bridge forces
//!   `set_human_speaking(false)` so the duck envelope releases.
//! - The Sexton *owns* the TS connection. Bridge has no opinion on
//!   reconnecting to TS.

mod bridge_client;
mod mixer;
mod protocol;
mod ws_server;

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{broadcast, mpsc};

use bridge_client::IpcConfig;
use mixer::Mixer;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let ipc_config = IpcConfig::from_env()?;
    let ws_bind: std::net::SocketAddr = std::env::var("WS_BIND")
        .unwrap_or_else(|_| "0.0.0.0:9099".to_string())
        .parse()?;
    let duck_gain: f32 = std::env::var("DUCK_GAIN")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.25);
    let tts_webhook_url = std::env::var("TTS_WEBHOOK_URL").ok().filter(|s| !s.is_empty());

    log::info!(
        "ts-bridge starting: ipc={} ws={} duck={:.2}",
        ipc_config.socket_path.display(),
        ws_bind,
        duck_gain
    );

    // Mixer outlives every connection attempt (PHA-3216 lesson).
    let mixer = Arc::new(tokio::sync::Mutex::new(Mixer::new(duck_gain)));

    // BridgeCommand (outbound) and BridgeEvent (inbound) cross the
    // mpsc/broadcast boundary from the IPC client to the WS server.
    // The WS server is the only consumer of outbound commands; the
    // IPC client is the only producer. The WS server is the only
    // consumer of inbound events; the IPC client is the only producer.
    // 256-deep broadcast mirrors the pre-PHA-3341 shape; per-speaker
    // audio at 50 fps from a handful of talkers plus roster/text/
    // state events comfortably fits, a slow WS client just drops old
    // frames (Lagged) rather than stalling everyone else.
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<bridge_proto::BridgeCommand>();
    let cmd_rx = Arc::new(tokio::sync::Mutex::new(cmd_rx));
    let (event_tx, _) = broadcast::channel::<bridge_proto::BridgeEvent>(256);

    // Snapshot is the on-bridge side of "what the WS server replays
    // for a freshly connected client". Populated by the IPC client's
    // `Hello` and updated by subsequent `State`/`Roster` events.
    let snapshot = Arc::new(tokio::sync::Mutex::new(
        bridge_proto::Snapshot::default(),
    ));

    // WS server runs in parallel with the IPC client; it talks only
    // to the local command/event channels. It holds the SENDER half
    // of `cmd_tx` and pushes inbound commands; the receiver half is
    // shared with the IPC client behind an `Arc<Mutex<>>` so the
    // reconnect loop can pass it to `run` without owning it.
    let ws_mixer = mixer.clone();
    let ws_event_tx = event_tx.clone();
    let ws_snapshot = snapshot.clone();
    let ws_cmd_tx = cmd_tx.clone();
    let ws_tts = tts_webhook_url.clone();
    tokio::spawn(async move {
        if let Err(e) = ws_server::run(ws_bind, ws_mixer, ws_cmd_tx, ws_event_tx, ws_tts, ws_snapshot).await {
            log::error!("websocket server exited: {e}");
        }
    });

    // IPC reconnect loop — exponential backoff, same shape as the
    // pre-PHA-3341 TS reconnect loop. The first attempt waits for the
    // socket to exist; subsequent attempts fire immediately.
    let mut backoff = Duration::from_secs(1);
    const MAX_BACKOFF: Duration = Duration::from_secs(60);
    loop {
        log::info!("connecting to sexton at {}...", ipc_config.socket_path.display());
        match bridge_client::run(
            &ipc_config,
            cmd_rx.clone(),
            event_tx.clone(),
            snapshot.clone(),
        )
        .await
        {
            Ok(()) => log::warn!("sexton ipc loop ended cleanly; reconnecting"),
            Err(e) => log::error!("sexton ipc loop failed: {e}; reconnecting in {backoff:?}"),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}