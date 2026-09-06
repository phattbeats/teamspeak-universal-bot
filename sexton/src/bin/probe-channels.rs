//! Quick connectivity / ban-check probe: connect, print the channel tree (or
//! the connect error — e.g. `ConnectFailedBanned`), then disconnect.

use anyhow::{anyhow, Result};
use clap::Parser;
use futures::prelude::*;
use tracing::info;

use tsclientlib::messages::c2s::OutChannelListRequestMessage;
use tsclientlib::prelude::*;
use tsclientlib::{Connection, DisconnectOptions, Identity, StreamItem};

#[derive(Parser, Debug)]
struct Args {
    #[arg(short = 'a', long, default_value = "teamspeak.phatt.vip:9987")]
    address: String,

    #[arg(short = 'n', long, default_value = "SextonProbe")]
    nickname: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let args = Args::parse();

    let identity = Identity::create();
    let mut con = Connection::build(args.address.clone())
        .identity(identity)
        .name(args.nickname.clone())
        .connect()
        .map_err(|e| anyhow!("connect: {e}"))?;

    let first_book = con
        .events()
        .try_filter(|e| future::ready(matches!(e, StreamItem::BookEvents(_))))
        .next()
        .await;
    match first_book {
        Some(Ok(_)) => {}
        Some(Err(e)) => return Err(anyhow!("waiting for initial book events: {e}")),
        None => return Err(anyhow!("stream ended before first book events")),
    }

    OutChannelListRequestMessage::new()
        .send(&mut con)
        .map_err(|e| anyhow!("channellist request: {e}"))?;
    {
        let state = con.get_state().map_err(|e| anyhow!("get_state: {e}"))?;
        state
            .server
            .set_subscribed(true)
            .send(&mut con)
            .map_err(|e| anyhow!("channelsubscribeall: {e}"))?;
    }

    // Pump the event stream while the channel list arrives — tsclientlib only
    // applies book updates while its stream is polled, so sleeping here prints
    // an empty tree no matter how long we wait.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match tokio::time::timeout_at(deadline, con.events().next()).await {
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(anyhow!("waiting for channel list: {e}")),
            Ok(None) => return Err(anyhow!("stream ended while waiting for channel list")),
            Err(_) => break,
        }
    }

    let state = con.get_state().map_err(|e| anyhow!("get_state: {e}"))?;
    info!(server = %state.server.name, "connected");
    for (id, ch) in state.channels.iter() {
        println!("{:?}  {}", id, ch.name);
    }
    let _ = state;

    con.disconnect(DisconnectOptions::new()).ok();
    Ok(())
}
