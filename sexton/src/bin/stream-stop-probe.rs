//! PHA-5171 probe: which `stopstream` form does the TS6 server honour?
//!
//! Connects as a throwaway identity, joins `--channel`, sets up a share, and
//! once `notifystreamstarted` arrives tries each stop variant in turn, printing
//! every command line the server sends back. A variant works when the server
//! answers with `notifystreamstopped` (or flips our `client_is_streaming` to 0).

use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use clap::Parser;
use futures::prelude::*;
use tokio::sync::mpsc;
use tsclientlib::messages::c2s::{OutClientMoveMessage, OutClientMovePart};
use tsclientlib::{Connection, Identity, OutCommandExt, StreamItem};
use tsproto::connection::Event as RawEvent;
use tsproto_packets::packets::{Direction as PDir, Flags, OutCommand, PacketType};

#[derive(Parser, Debug)]
struct Args {
    #[arg(short = 'a', long, default_value = "teamspeak.phatt.vip:9987")]
    address: String,
    #[arg(short = 'c', long, default_value = "Bot Jail")]
    channel: String,
    /// `|`-separated stop lines to try in order; `{sid}` is the stream id.
    #[arg(long, default_value = "stopstream id={sid} return_code=51711|stopstream stream_id={sid} return_code=51712|stopstream return_code=51713")]
    variants: String,
}

fn send_raw(con: &mut Connection, line: &str) {
    println!(">> {line}");
    if let Err(e) = OutCommand::new(PDir::C2S, Flags::empty(), PacketType::Command, line).send(con) {
        println!("send failed: {e}");
    }
}

/// Pump the connection for `d`, returning every command line received.
async fn pump(con: &mut Connection, rx: &mut mpsc::UnboundedReceiver<String>, d: Duration) -> Result<Vec<String>> {
    let end = Instant::now() + d;
    let mut got = vec![];
    while Instant::now() < end {
        let left = end - Instant::now();
        let ev = {
            let mut evs = con.events();
            tokio::select! {
                e = evs.next() => Some(e),
                Some(l) = rx.recv() => { got.push(l); None }
                _ = tokio::time::sleep(left) => None,
            }
        };
        if let Some(Some(Err(e))) = ev {
            return Err(anyhow!("ts: {e}"));
        }
    }
    while let Ok(l) = rx.try_recv() {
        got.push(l);
    }
    Ok(got)
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let mut con = Connection::build(args.address.clone())
        .identity(Identity::create())
        .name("SextonStopProbe".to_string())
        .connect()
        .map_err(|e| anyhow!("connect: {e}"))?;
    con.events().try_filter(|e| future::ready(matches!(e, StreamItem::BookEvents(_)))).next().await;

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    con.get_tsproto_client_mut().map_err(|e| anyhow!("raw: {e}"))?.event_listeners.push(Box::new(
        move |ev: &RawEvent| {
            if let RawEvent::ReceivePacket(p) = ev {
                if p.header().packet_type().is_command() {
                    let _ = tx.send(String::from_utf8_lossy(p.content()).into_owned());
                }
            }
        },
    ));

    tsclientlib::messages::c2s::OutChannelListRequestMessage::new().send(&mut con).map_err(|e| anyhow!("{e}"))?;
    pump(&mut con, &mut rx, Duration::from_secs(3)).await?;
    let own = con.get_state().map_err(|e| anyhow!("{e}"))?.own_client;
    let chan = con
        .get_state()
        .map_err(|e| anyhow!("{e}"))?
        .channels
        .iter()
        .find(|(_, c)| c.name == args.channel)
        .map(|(id, _)| *id)
        .ok_or_else(|| anyhow!("channel {} not found", args.channel))?;
    OutClientMoveMessage::new(&mut std::iter::once(OutClientMovePart { client_id: own, channel_id: chan, channel_password: None }))
        .send(&mut con)
        .map_err(|e| anyhow!("{e}"))?;
    pump(&mut con, &mut rx, Duration::from_secs(2)).await?;
    println!("own clid={} in {}", own.0, args.channel);

    send_raw(&mut con, "setupstream name=stop\\sprobe type=3 accessibility=1 mode=1 bitrate=1000 viewer_limit=0 audio=0 return_code=51710");
    let mut sid = String::new();
    for l in pump(&mut con, &mut rx, Duration::from_secs(5)).await? {
        if l.contains("stream") || l.starts_with("error") {
            println!("<< {}", &l[..l.len().min(300)]);
        }
        if l.starts_with("notifystreamstarted") && l.contains(&format!("clid={}", own.0)) {
            sid = l.split(' ').find_map(|t| t.strip_prefix("id=")).unwrap_or("").to_string();
        }
    }
    anyhow::ensure!(!sid.is_empty(), "no notifystreamstarted for us");
    println!("sid={sid}");

    for v in args.variants.split('|') {
        send_raw(&mut con, &v.replace("{sid}", &sid));
        let mut stopped = false;
        for l in pump(&mut con, &mut rx, Duration::from_secs(4)).await? {
            if l.contains("stream") || l.starts_with("error") {
                println!("<< {}", &l[..l.len().min(300)]);
            }
            stopped |= l.starts_with("notifystreamstopped");
        }
        if stopped {
            println!("RESULT: works -> {v}");
            break;
        }
        println!("RESULT: no notifystreamstopped for -> {v}");
    }
    let _ = con.disconnect(tsclientlib::DisconnectOptions::new());
    pump(&mut con, &mut rx, Duration::from_secs(1)).await.ok();
    Ok(())
}
