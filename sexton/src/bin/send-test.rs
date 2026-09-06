//! Verification helper for PHA-3107 / PHA-3173: join a channel as a throwaway
//! identity, optionally send a comma-separated list of text messages to it,
//! optionally linger (so a second connection can be observed as a "joiner").

use anyhow::{anyhow, Context, Result};
use clap::Parser;
use futures::prelude::*;
use tracing::info;

use tsclientlib::prelude::*;
use tsclientlib::messages::c2s::{
    OutChannelListRequestMessage, OutClientMoveMessage, OutClientMovePart,
};
use tsclientlib::{Connection, DisconnectOptions, Identity, MessageTarget, StreamItem};

#[derive(Parser, Debug)]
struct Args {
    #[arg(short = 'a', long, default_value = "teamspeak.phatt.vip:9987")]
    address: String,

    #[arg(short = 'n', long, default_value = "TestUser")]
    nickname: String,

    /// Channel NAME to join.
    #[arg(short = 'c', long)]
    channel: String,

    /// Comma-separated messages to send. Empty => don't send.
    #[arg(short = 'm', long, default_value = "")]
    messages: String,

    /// If set, sit in the channel for this many seconds after sending (for
    /// joiner-detection test).
    #[arg(long, default_value_t = 0)]
    linger_seconds: u64,
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
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let (own_client_id, channel_id) = {
        let state = con.get_state().map_err(|e| anyhow!("get_state: {e}"))?;
        let own_client_id = state.own_client;
        let channel_id = state
            .channels
            .iter()
            .find(|(_, ch)| ch.name == args.channel)
            .map(|(id, _)| *id)
            .ok_or_else(|| anyhow!("channel {:?} not found", args.channel))?;
        (own_client_id, channel_id)
    };
    info!(?channel_id, "resolved channel");

    OutClientMoveMessage::new(&mut std::iter::once(OutClientMovePart {
        client_id: own_client_id,
        channel_id,
        channel_password: None,
    }))
    .send(&mut con)
    .map_err(|e| anyhow!("joining channel: {e}"))?;
    info!("joined channel");

    if !args.messages.is_empty() {
        for msg in args.messages.split(',') {
            let cmd = {
                let state = con.get_state().map_err(|e| anyhow!("get_state: {e}"))?;
                state.send_message(MessageTarget::Channel, msg)
            };
            cmd.send(&mut con).map_err(|e| anyhow!("sending text message: {e}"))?;
            info!(message = %msg, "sent");
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
    }

    if args.linger_seconds > 0 {
        info!(seconds = args.linger_seconds, "lingering");
        tokio::time::sleep(std::time::Duration::from_secs(args.linger_seconds)).await;
    }

    con.disconnect(DisconnectOptions::new())
        .context("disconnect")?;
    Ok(())
}
