//! Verification helper for PHA-3107 / PHA-3173: join a channel as a throwaway
//! identity and run a scripted sequence of actions against it — text messages,
//! mute/unmute, and a channel hop — so the Sexton's "content only" hard rule
//! can be exercised in a deterministic order.
//!
//! The script is a comma-separated list of steps:
//!   `say:<text>`   send <text> to the watched channel
//!   `mute`         set client_input_muted=1
//!   `unmute`       set client_input_muted=0
//!   `hop`          create/join a temporary side channel
//!   `back`         move back into the watched channel
//!   `wait:<ms>`    pump the connection for <ms> milliseconds
//!
//! e.g. `--script "say:one,mute,say:two,hop,back,say:three"`.

use std::time::Duration as StdDuration;

use anyhow::{anyhow, Context, Result};
use clap::Parser;
use futures::prelude::*;
use tracing::info;

use tsclientlib::prelude::*;
use tsclientlib::messages::c2s::{
    OutChannelCreateMessage, OutChannelCreatePart, OutChannelListRequestMessage,
    OutClientMoveMessage, OutClientMovePart,
};
use tsclientlib::{
    events::Event, ChannelId, ClientId, Connection, DisconnectOptions, Identity, MessageTarget,
    StreamItem,
};

/// How long to wait for the server to answer our `channellist` request.
const CHANNEL_TREE_TIMEOUT: StdDuration = StdDuration::from_secs(15);
/// Settle time after each scripted step, so the server (and the Sexton) sees
/// the steps in the order we issued them.
const STEP_SETTLE: StdDuration = StdDuration::from_millis(800);

#[derive(Parser, Debug)]
struct Args {
    #[arg(short = 'a', long, default_value = "teamspeak6-server:9987")]
    address: String,

    #[arg(short = 'n', long, default_value = "TestUser")]
    nickname: String,

    /// Channel NAME to join.
    #[arg(short = 'c', long)]
    channel: String,

    /// Comma-separated script of steps (see module docs). Empty => just join.
    #[arg(short = 's', long, default_value = "")]
    script: String,

    /// Name of the temporary side channel `hop` creates/joins.
    #[arg(long, default_value = "sexton-hop-test")]
    hop_channel: String,

    /// If set, sit in the channel for this many seconds after the script (for
    /// joiner-detection tests).
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

    // The book only advances while the event stream is polled — pump it while
    // we wait for the channel list instead of sleeping.
    let own_client_id = con
        .get_state()
        .map_err(|e| anyhow!("get_state: {e}"))?
        .own_client;
    let channel_id = wait_for_channel(&mut con, &args.channel).await?;
    info!(?channel_id, own = ?own_client_id, "resolved channel");

    move_to(&mut con, own_client_id, channel_id)?;
    pump(&mut con, STEP_SETTLE).await?;
    info!("joined channel");

    for step in args.script.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        run_step(&mut con, &args, own_client_id, channel_id, step).await?;
        pump(&mut con, STEP_SETTLE).await?;
    }

    if args.linger_seconds > 0 {
        info!(seconds = args.linger_seconds, "lingering");
        pump(&mut con, StdDuration::from_secs(args.linger_seconds)).await?;
    }

    con.disconnect(DisconnectOptions::new())
        .context("disconnect")?;
    Ok(())
}

async fn run_step(
    con: &mut Connection,
    args: &Args,
    own_client_id: ClientId,
    channel_id: ChannelId,
    step: &str,
) -> Result<()> {
    match step.split_once(':') {
        Some(("say", text)) => {
            let cmd = {
                let state = con.get_state().map_err(|e| anyhow!("get_state: {e}"))?;
                state.send_message(MessageTarget::Channel, text)
            };
            cmd.send(con).map_err(|e| anyhow!("sending text message: {e}"))?;
            info!(message = %text, "step: say");
        }
        Some(("wait", ms)) => {
            let ms: u64 = ms.parse().with_context(|| format!("parsing wait:{ms}"))?;
            info!(ms, "step: wait");
            pump(con, StdDuration::from_millis(ms)).await?;
        }
        None if step == "mute" || step == "unmute" => {
            let muted = step == "mute";
            let cmd = {
                let state = con.get_state().map_err(|e| anyhow!("get_state: {e}"))?;
                state.client_update().set_input_muted(muted)
            };
            cmd.send(con).map_err(|e| anyhow!("clientupdate input_muted: {e}"))?;
            info!(muted, "step: mute toggle");
        }
        None if step == "hop" => {
            let hop_id = match find_channel(con, &args.hop_channel)? {
                Some(id) => id,
                None => {
                    create_temp_channel(con, &args.hop_channel)?;
                    pump(con, STEP_SETTLE).await?;
                    find_channel(con, &args.hop_channel)?.ok_or_else(|| {
                        anyhow!("temporary channel {:?} never appeared", args.hop_channel)
                    })?
                }
            };
            move_to(con, own_client_id, hop_id)?;
            info!(?hop_id, "step: hop");
        }
        None if step == "back" => {
            move_to(con, own_client_id, channel_id)?;
            info!(?channel_id, "step: back");
        }
        _ => return Err(anyhow!("unknown script step {step:?}")),
    }
    Ok(())
}

/// Poll the event stream until `name` shows up in the channel tree.
async fn wait_for_channel(con: &mut Connection, name: &str) -> Result<ChannelId> {
    let deadline = tokio::time::Instant::now() + CHANNEL_TREE_TIMEOUT;
    loop {
        if let Some(id) = find_channel(con, name)? {
            return Ok(id);
        }
        match tokio::time::timeout_at(deadline, con.events().next()).await {
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(anyhow!("waiting for channel list: {e}")),
            Ok(None) => return Err(anyhow!("stream ended while waiting for channel list")),
            Err(_) => return Err(anyhow!("channel {name:?} not found in channel tree")),
        }
    }
}

fn find_channel(con: &mut Connection, name: &str) -> Result<Option<ChannelId>> {
    let state = con.get_state().map_err(|e| anyhow!("get_state: {e}"))?;
    Ok(state
        .channels
        .iter()
        .find(|(_, ch)| ch.name == name)
        .map(|(id, _)| *id))
}

fn create_temp_channel(con: &mut Connection, name: &str) -> Result<()> {
    OutChannelCreateMessage::new(&mut std::iter::once(OutChannelCreatePart {
        parent_id: Some(ChannelId(0)),
        name: name.into(),
        topic: None,
        description: None,
        password: None,
        codec: None,
        codec_quality: None,
        max_clients: None,
        max_family_clients: None,
        order: None,
        has_password: None,
        is_unencrypted: None,
        delete_delay: None,
        is_max_clients_unlimited: None,
        is_max_family_clients_unlimited: None,
        inherits_max_family_clients: None,
        phonetic_name: None,
        // Neither permanent nor semi-permanent => temporary: the server drops
        // it as soon as the last client leaves, so the test cleans up after
        // itself.
        is_permanent: Some(false),
        is_semi_permanent: Some(false),
        is_default: None,
    }))
    .send(con)
    .map_err(|e| anyhow!("channelcreate: {e}"))
}

fn move_to(con: &mut Connection, client_id: ClientId, channel_id: ChannelId) -> Result<()> {
    OutClientMoveMessage::new(&mut std::iter::once(OutClientMovePart {
        client_id,
        channel_id,
        channel_password: None,
    }))
    .send(con)
    .map_err(|e| anyhow!("clientmove: {e}"))
}

/// Drive the connection for `dur` — tsclientlib does nothing (no sends, no
/// keepalives, no book updates) unless its event stream is being polled.
///
/// Every private message we receive while pumping is printed, so a test run
/// can show the Sexton's catch-up PM from the *receiving* side.
async fn pump(con: &mut Connection, dur: StdDuration) -> Result<()> {
    let deadline = tokio::time::Instant::now() + dur;
    loop {
        match tokio::time::timeout_at(deadline, con.events().next()).await {
            Ok(Some(Ok(StreamItem::BookEvents(events)))) => {
                for ev in events {
                    if let Event::Message { target: MessageTarget::Client(_), invoker, message } =
                        ev
                    {
                        println!("<<< PM from {}:\n{}", invoker.name, message);
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(anyhow!("event stream error: {e}")),
            Ok(None) => return Err(anyhow!("event stream ended")),
            Err(_) => return Ok(()),
        }
    }
}
