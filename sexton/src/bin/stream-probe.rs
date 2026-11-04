//! PHA-3289 probe: does a TS6 server accept the screen-share signalling
//! commands as legacy TS3 text commands over tsproto UDP?
//!
//! Connects with a fresh identity, sends each `--cmd` raw (no escaping, the
//! text is the whole command line; a `return_code` is appended), logs the
//! matching `error id=` result, then idles for `--listen-seconds` logging
//! everything. Run with RUST_LOG=tsproto=debug,stream_probe=info to also see
//! the raw text of every inbound/outbound command (incl. notifies tsclientlib
//! cannot parse).

use std::collections::HashMap;
use std::time::Duration as StdDuration;

use anyhow::{anyhow, Result};
use clap::Parser;
use futures::prelude::*;

use tsclientlib::messages::c2s::{OutClientMoveMessage, OutClientMovePart};
use tsclientlib::prelude::*;
use tsclientlib::{Connection, Identity, MessageHandle, StreamItem};
use tsproto_packets::packets::{Direction, Flags, OutCommand, PacketType};

#[derive(Parser, Debug)]
struct Args {
    #[arg(short = 'a', long, default_value = "teamspeak6-server:9987")]
    address: String,
    #[arg(short = 'n', long, default_value = "stream-probe")]
    nickname: String,
    /// Optional channel NAME to move into before probing.
    #[arg(short = 'c', long, default_value = "")]
    channel: String,
    /// Raw command text, repeatable, sent in order.
    #[arg(long = "cmd")]
    cmds: Vec<String>,
    #[arg(long, default_value_t = 5)]
    reply_timeout: u64,
    #[arg(long, default_value_t = 20)]
    listen_seconds: u64,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let args = Args::parse();

    let mut con = Connection::build(args.address.clone())
        .identity(Identity::create())
        .name(args.nickname.clone())
        .log_commands(true)
        .connect()
        .map_err(|e| anyhow!("connect: {e}"))?;

    loop {
        match con.events().next().await {
            Some(Ok(StreamItem::BookEvents(_))) => break,
            Some(Ok(_)) => {}
            Some(Err(e)) => return Err(anyhow!("connect wait: {e}")),
            None => return Err(anyhow!("stream ended before connect")),
        }
    }
    let own = con.get_state().map_err(|e| anyhow!("{e}"))?.own_client;
    println!("=== connected, own client id {:?}", own);
    {
        let st = con.get_state().map_err(|e| anyhow!("{e}"))?;
        st.server.set_subscribed(true).send(&mut con).map_err(|e| anyhow!("{e}"))?;
    }
    pump(&mut con, StdDuration::from_secs(2), &mut HashMap::new()).await?;

    if !args.channel.is_empty() {
        let cid = con
            .get_state()
            .map_err(|e| anyhow!("{e}"))?
            .channels
            .iter()
            .find(|(_, c)| c.name == args.channel)
            .map(|(id, _)| *id);
        match cid {
            Some(cid) => {
                OutClientMoveMessage::new(&mut std::iter::once(OutClientMovePart {
                    client_id: own,
                    channel_id: cid,
                    channel_password: None,
                }))
                .send(&mut con)
                .map_err(|e| anyhow!("{e}"))?;
                println!("=== moved to channel {:?} ({:?})", args.channel, cid);
                pump(&mut con, StdDuration::from_secs(1), &mut HashMap::new()).await?;
            }
            None => println!("=== channel {:?} not found, staying put", args.channel),
        }
    }

    for raw in &args.cmds {
        let cmd = OutCommand::new(Direction::C2S, Flags::empty(), PacketType::Command, raw);
        let h = cmd.send_with_result(&mut con).map_err(|e| anyhow!("send {raw}: {e}"))?;
        let mut pending = HashMap::new();
        pending.insert(h, raw.clone());
        println!(">>> SEND [{:?}] {}", h, raw);
        pump(&mut con, StdDuration::from_secs(args.reply_timeout), &mut pending).await?;
        for (h, raw) in pending {
            println!("!!! NO RESULT within timeout [{:?}] {}", h, raw);
        }
    }

    println!("=== idle listening {}s", args.listen_seconds);
    pump(&mut con, StdDuration::from_secs(args.listen_seconds), &mut HashMap::new()).await?;
    println!("=== done");
    Ok(())
}

async fn pump(
    con: &mut Connection, dur: StdDuration, pending: &mut HashMap<MessageHandle, String>,
) -> Result<()> {
    let deadline = tokio::time::Instant::now() + dur;
    loop {
        match tokio::time::timeout_at(deadline, con.events().next()).await {
            Ok(Some(Ok(StreamItem::MessageResult(h, res)))) => {
                let raw = pending.remove(&h).unwrap_or_default();
                println!("<<< RESULT [{:?}] {:?}  (for: {})", h, res, raw);
            }
            Ok(Some(Ok(StreamItem::MessageEvent(msg)))) => {
                println!("<<< UNHANDLED MESSAGE {:?}", msg);
            }
            Ok(Some(Ok(StreamItem::BookEvents(evs)))) => {
                for e in evs {
                    println!("<<< BOOK {:?}", e);
                }
            }
            Ok(Some(Ok(other))) => println!("<<< ITEM {:?}", other),
            Ok(Some(Err(e))) => return Err(anyhow!("event stream error: {e}")),
            Ok(None) => return Err(anyhow!("event stream ended")),
            Err(_) => return Ok(()),
        }
    }
}
