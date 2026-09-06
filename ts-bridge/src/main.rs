mod config;
mod mixer;
mod protocol;
mod ts_client;
mod ws_server;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{broadcast, mpsc};

use config::Config;
use mixer::Mixer;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let config = Config::from_env()?;
    let mixer = Arc::new(Mutex::new(Mixer::new(config.duck_gain)));
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel();
    // 256-deep broadcast: per-speaker audio at 50 fps from a handful of
    // talkers plus roster/text/state events comfortably fit; a slow
    // `bridge-test`-style client just drops old frames (Lagged) rather than
    // stalling everyone else.
    let (event_tx, _) = broadcast::channel(256);

    let ws_bind = config.ws_bind;
    let tts_url = config.tts_webhook_url.clone();
    let ws_mixer = mixer.clone();
    let ws_event_tx = event_tx.clone();
    // Shared with the TS loop so a WebSocket client that connects between two
    // roster changes still gets the current state and roster (PROTOCOL.md).
    // Outlives each connection attempt, like the mixer does.
    let snapshot = Arc::new(Mutex::new(ts_client::Snapshot::default()));
    let ws_snapshot = snapshot.clone();
    tokio::spawn(async move {
        if let Err(e) = ws_server::run(ws_bind, ws_mixer, cmd_tx, ws_event_tx, tts_url, ws_snapshot).await {
            log::error!("websocket server exited: {e}");
        }
    });

    // Reconnect with polite backoff (PHA-3099's standing requirement for all
    // Sexton-family bots): on any error from the TS connection loop, wait
    // and try again rather than exiting the container.
    let mut backoff = Duration::from_secs(1);
    const MAX_BACKOFF: Duration = Duration::from_secs(60);
    loop {
        log::info!("connecting to {}...", config.server_address);
        match ts_client::run(&config, mixer.clone(), &mut cmd_rx, event_tx.clone(), snapshot.clone()).await {
            Ok(()) => log::warn!("ts connection loop ended cleanly; reconnecting"),
            Err(e) => log::error!("ts connection loop failed: {e}; reconnecting in {backoff:?}"),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}
