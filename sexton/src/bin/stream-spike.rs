//! PHA-4499 phase 1 spike: publish a canned H264 clip as a TS6 screen share.
//!
//! Joins `--channel`, sends `setupstream`, and for every `notifyjoinstreamrequest`
//! answers with a str0m (non-libwebrtc) offer carrying H264 High. Pass/fail is a
//! TS6 desktop viewer watching for ~30 s without the client crashing (the
//! `RTC_CHECK` ~2 s after connect that STREAMING.md documents for aiortc).
//!
//! Input is an Annex-B H264 file with AUDs (`x264 aud=1`), looped at --fps.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use clap::Parser;
use futures::prelude::*;
use str0m::change::{SdpAnswer, SdpPendingOffer};
use str0m::format::Codec;
use str0m::media::{Direction, MediaKind, MediaTime, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event as RtcEvent, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tracing::{info, warn};
use tsclientlib::messages::c2s::{OutClientMoveMessage, OutClientMovePart};
use tsclientlib::{Connection, Identity, OutCommandExt, StreamItem};
use tsproto::connection::Event as RawEvent;
use tsproto_packets::packets::{Direction as PDir, Flags, OutCommand, PacketType};

#[derive(Parser, Debug)]
struct Args {
    #[arg(short = 'a', long, default_value = "10.0.0.100:9987")]
    address: String,
    #[arg(short = 'n', long, default_value = "SextonStreamSpike")]
    nickname: String,
    #[arg(short = 'c', long)]
    channel: String,
    /// Annex-B H264 High clip with AUDs.
    #[arg(long)]
    clip: String,
    /// LAN IP advertised as the ICE host candidate.
    #[arg(long, default_value = "10.0.0.100")]
    ip: String,
    #[arg(long, default_value_t = 40000)]
    port: u16,
    #[arg(long, default_value_t = 30)]
    fps: u32,
    #[arg(long, default_value_t = 120)]
    seconds: u64,
}

fn esc(v: &str) -> String {
    let mut o = String::new();
    for c in v.chars() {
        match c {
            '\\' => o.push_str("\\\\"),
            '/' => o.push_str("\\/"),
            ' ' => o.push_str("\\s"),
            '|' => o.push_str("\\p"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c => o.push(c),
        }
    }
    o
}

fn unesc(v: &str) -> String {
    let mut o = String::new();
    let mut it = v.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            o.push(c);
            continue;
        }
        match it.next() {
            Some('s') => o.push(' '),
            Some('p') => o.push('|'),
            Some('n') => o.push('\n'),
            Some('r') => o.push('\r'),
            Some('t') => o.push('\t'),
            Some(x) => o.push(x),
            None => {}
        }
    }
    o
}

fn parse(text: &str) -> (String, HashMap<String, String>) {
    let first = text.split('|').next().unwrap_or("");
    let mut name = String::new();
    let mut args = HashMap::new();
    for (i, tok) in first.split(' ').enumerate() {
        if i == 0 && !tok.contains('=') {
            name = tok.to_string();
            continue;
        }
        if let Some((k, v)) = tok.split_once('=') {
            args.insert(k.to_string(), unesc(v));
        }
    }
    (name, args)
}

fn raw_line(name: &str, args: &[(&str, String)]) -> String {
    let mut l = name.to_string();
    for (k, v) in args {
        l.push(' ');
        l.push_str(k);
        l.push('=');
        l.push_str(&esc(v));
    }
    l
}

fn send_raw(con: &mut Connection, line: &str) {
    info!(">> {}", &line[..line.len().min(160)]);
    let cmd = OutCommand::new(PDir::C2S, Flags::empty(), PacketType::Command, line);
    if let Err(e) = cmd.send(con) {
        warn!("send_raw: {e}");
    }
}

/// Split an Annex-B stream into access units on AUD (NAL type 9) boundaries.
fn split_aus(data: &[u8]) -> Vec<Vec<u8>> {
    let mut starts = vec![];
    let mut i = 0;
    while i + 4 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            if data[i + 3] & 0x1f == 9 {
                // include a preceding zero byte (4-byte start code)
                starts.push(if i > 0 && data[i - 1] == 0 { i - 1 } else { i });
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut aus = vec![];
    for w in 0..starts.len() {
        let end = starts.get(w + 1).copied().unwrap_or(data.len());
        aus.push(data[starts[w]..end].to_vec());
    }
    aus
}

struct Viewer {
    clid: String,
    rtc: Rtc,
    mid_v: Mid,
    pending: Option<SdpPendingOffer>,
    connected: bool,
    announced: usize,
    wait_idr: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let args = Args::parse();
    let aus = split_aus(&std::fs::read(&args.clip)?);
    anyhow::ensure!(!aus.is_empty(), "no access units found (need x264 aud=1)");
    info!(frames = aus.len(), "clip loaded");

    let mut con = Connection::build(args.address.clone())
        .identity(Identity::create())
        .name(args.nickname.clone())
        .connect()
        .map_err(|e| anyhow!("connect: {e}"))?;
    con.events()
        .try_filter(|e| future::ready(matches!(e, StreamItem::BookEvents(_))))
        .next()
        .await;

    // Hook raw notifystream* commands.
    let (tx, mut rx) = mpsc::unbounded_channel::<(String, HashMap<String, String>)>();
    {
        let raw = con.get_tsproto_client_mut().map_err(|e| anyhow!("raw: {e}"))?;
        let tx = tx.clone();
        raw.event_listeners.push(Box::new(move |ev: &RawEvent| {
            if let RawEvent::ReceivePacket(p) = ev {
                if p.header().packet_type().is_command() {
                    let text = String::from_utf8_lossy(p.content());
                    let name = text.split(|c| c == ' ' || c == '|').next().unwrap_or("");
                    if name.starts_with("notifystream")
                        || name == "notifyjoinstreamrequest"
                        || name == "notifyrespondjoinstreamrequest"
                        || name == "notifyremovedfromstream"
                        || (name == "error" && text.contains(" return_code="))
                    {
                        let _ = tx.send(parse(&text));
                    }
                }
            }
        }));
    }

    // Join the channel.
    tsclientlib::messages::c2s::OutChannelListRequestMessage::new()
        .send(&mut con)
        .map_err(|e| anyhow!("{e}"))?;
    let own = con.get_state().map_err(|e| anyhow!("{e}"))?.own_client;
    let mut chan = None;
    let t0 = Instant::now();
    while chan.is_none() && t0.elapsed() < Duration::from_secs(15) {
        let _ = tokio::time::timeout(Duration::from_millis(300), con.events().next()).await;
        let st = con.get_state().map_err(|e| anyhow!("{e}"))?;
        chan = st.channels.iter().find(|(_, c)| c.name == args.channel).map(|(id, _)| *id);
    }
    let chan = chan.ok_or_else(|| anyhow!("channel {} not found", args.channel))?;
    OutClientMoveMessage::new(&mut std::iter::once(OutClientMovePart {
        client_id: own,
        channel_id: chan,
        channel_password: None,
    }))
    .send(&mut con)
    .map_err(|e| anyhow!("{e}"))?;
    info!("joined {}", args.channel);

    send_raw(
        &mut con,
        &raw_line(
            "setupstream",
            &[
                ("name", "Sexton spike".into()),
                ("type", "3".into()),
                ("accessibility", "1".into()),
                ("mode", "1".into()),
                ("bitrate", "4608".into()),
                ("viewer_limit", "0".into()),
                ("audio", "0".into()),
                ("return_code", "9001".into()),
            ],
        ),
    );

    let sock = UdpSocket::bind(("0.0.0.0", args.port)).await?;
    let local: SocketAddr = format!("{}:{}", args.ip, args.port).parse()?;
    let mut sid = String::new();
    let mut viewers: HashMap<String, Viewer> = HashMap::new();
    let mut ticker = tokio::time::interval(Duration::from_micros(1_000_000 / args.fps as u64));
    let mut frame_no: usize = 0;
    let deadline = Instant::now() + Duration::from_secs(args.seconds);
    let mut buf = vec![0u8; 2000];

    while Instant::now() < deadline {
        // Drain every viewer's rtc outputs; find the nearest timeout.
        let mut next = Instant::now() + Duration::from_millis(500);
        for v in viewers.values_mut() {
            loop {
                match v.rtc.poll_output() {
                    Ok(Output::Timeout(t)) => {
                        next = next.min(t);
                        break;
                    }
                    Ok(Output::Transmit(t)) => {
                        let _ = sock.send_to(&t.contents, t.destination).await;
                    }
                    Ok(Output::Event(e)) => match e {
                        RtcEvent::Connected => info!("viewer {} DTLS connected", v.clid),
                        RtcEvent::IceConnectionStateChange(s) => {
                            info!("viewer {} ice {:?}", v.clid, s);
                            v.connected = matches!(s, IceConnectionState::Connected | IceConnectionState::Completed);
                        }
                        RtcEvent::KeyframeRequest(k) => info!("viewer {} PLI/FIR {:?}", v.clid, k.kind),
                        other => info!("viewer {} event {:?}", v.clid, other),
                    },
                    Err(e) => {
                        warn!("rtc error: {e}");
                        break;
                    }
                }
            }
        }
        let sleep = tokio::time::sleep_until(tokio::time::Instant::from_std(next));
        enum Ev {
            Ts(Option<Result<StreamItem, tsclientlib::Error>>),
            Cmd((String, HashMap<String, String>)),
            Udp(std::io::Result<(usize, SocketAddr)>),
            Timeout,
            Tick,
        }
        let ev = { let mut evs = con.events(); tokio::select! {
            e = evs.next() => Ev::Ts(e),
            Some(c) = rx.recv() => Ev::Cmd(c),
            r = sock.recv_from(&mut buf) => Ev::Udp(r),
            _ = ticker.tick() => Ev::Tick,
            _ = sleep => Ev::Timeout,
        } };
        match ev {
            Ev::Ts(Some(Err(e))) => return Err(anyhow!("ts: {e}")),
            Ev::Ts(None) => return Err(anyhow!("ts stream ended")),
            Ev::Ts(_) => {}
            Ev::Timeout => {
                let now = Instant::now();
                for v in viewers.values_mut() {
                    let _ = v.rtc.handle_input(Input::Timeout(now));
                }
            }
            Ev::Udp(Ok((n, src))) => {
                let now = Instant::now();
                if let Ok(contents) = (&buf[..n]).try_into() {
                    let input = Input::Receive(
                        now,
                        Receive { proto: Protocol::Udp, source: src, destination: local, contents },
                    );
                    for v in viewers.values_mut() {
                        if v.rtc.accepts(&input) {
                            let _ = v.rtc.handle_input(input);
                            break;
                        }
                    }
                }
            }
            Ev::Udp(Err(e)) => warn!("udp: {e}"),
            Ev::Tick => {
                let au = &aus[frame_no % aus.len()];
                let is_idr = au.windows(5).any(|w| w[..3] == [0, 0, 1] && w[3] & 0x1f == 5);
                let now = Instant::now();
                let ts = (frame_no as u64) * 90_000 / args.fps as u64;
                for v in viewers.values_mut() {
                    if !v.connected {
                        continue;
                    }
                    if v.wait_idr && !is_idr {
                        continue;
                    }
                    v.wait_idr = false;
                    let Some(w) = v.rtc.writer(v.mid_v) else { continue };
                    let pt = w.payload_params().find(|p| p.spec().codec == Codec::H264).map(|p| p.pt());
                    if let Some(pt) = pt {
                        if let Err(e) = w.write(pt, now, MediaTime::new(ts, str0m::media::Frequency::NINETY_KHZ), au.clone()) {
                            warn!("write: {e}");
                        }
                        v.announced += 1;
                    }
                }
                frame_no += 1;
            }
            Ev::Cmd((name, a)) => {
                info!("<< {} {:?}", name, a.iter().filter(|(k, _)| *k != "offer" && *k != "json").collect::<Vec<_>>());
                match name.as_str() {
                    "notifystreamstarted" if a.get("clid").map(|c| c.as_str()) == Some(&own.0.to_string()) => {
                        sid = a.get("id").cloned().unwrap_or_default();
                        info!("stream started sid={sid}");
                    }
                    "notifyjoinstreamrequest" => {
                        let clid = a.get("clid").cloned().unwrap_or_default();
                        if a.get("is_remove").map(|s| s.as_str()) == Some("1") {
                            viewers.remove(&clid);
                            continue;
                        }
                        let mut cfg = Rtc::builder().clear_codecs().enable_opus(true, false);
                        cfg.codec_config().add_h264(102.into(), Some(103.into()), true, 0x640c1f);
                        let mut rtc = cfg.build(Instant::now());
                        let cand = Candidate::host(local, "udp").map_err(|e| anyhow!("{e}"))?;
                        let cand_sdp = cand.to_sdp_string();
                        rtc.add_local_candidate(cand);
                        let mut api = rtc.sdp_api();
                        let mid_v = api.add_media(MediaKind::Video, Direction::SendOnly, Some("outgoing_video".into()), None, None);
                        let _ = api.add_media(MediaKind::Audio, Direction::Inactive, Some("outgoing_video".into()), None, None);
                        let (offer, pending) = api.apply().ok_or_else(|| anyhow!("no offer"))?;
                        let mut sdp = offer.to_sdp_string();
                        sdp = sdp.lines().filter(|l| !l.starts_with("a=candidate:") && !l.starts_with("a=end-of-candidates")).collect::<Vec<_>>().join("\r\n") + "\r\n";
                        info!("offer:\n{sdp}");
                        send_raw(&mut con, &raw_line("respondjoinstreamrequest", &[
                            ("id", sid.clone()), ("clid", clid.clone()), ("decision", "1".into()), ("offer", sdp), ("msg", String::new()),
                        ]));
                        // Trickle our host candidate.
                        let cs = cand_sdp.trim_start_matches("a=").to_string();
                        let json = format!(r#"{{"cmd":"iceCandidate","args":{{"mLine":0,"mid":"0","sdp":"{cs}"}}}}"#);
                        send_raw(&mut con, &raw_line("streamsignaling", &[("id", sid.clone()), ("clid", clid.clone()), ("json", json)]));
                        viewers.insert(clid.clone(), Viewer { clid, rtc, mid_v, pending: Some(pending), connected: false, announced: 0, wait_idr: true });
                    }
                    "notifystreamclientleft" | "notifyremovedfromstream" => {
                        if let Some(c) = a.get("clid") {
                            viewers.remove(c);
                        }
                    }
                    "notifystreamsignaling" => {
                        let clid = a.get("clid").cloned().unwrap_or_default();
                        let Some(v) = viewers.get_mut(&clid) else { continue };
                        let j: serde_json::Value = serde_json::from_str(a.get("json").map(|s| s.as_str()).unwrap_or("{}")).unwrap_or_default();
                        match j["cmd"].as_str() {
                            Some("answer") => {
                                let s = j["args"]["answer"].as_str().or(j["args"]["sdp"].as_str()).unwrap_or("");
                                info!("answer:\n{s}");
                                match (SdpAnswer::from_sdp_string(s), v.pending.take()) {
                                    (Ok(ans), Some(p)) => {
                                        if let Err(e) = v.rtc.sdp_api().accept_answer(p, ans) {
                                            warn!("accept_answer: {e}");
                                        }
                                    }
                                    (Err(e), _) => warn!("bad answer: {e}"),
                                    _ => {}
                                }
                            }
                            Some("iceCandidate") => {
                                let s = j["args"]["sdp"].as_str().unwrap_or("");
                                match Candidate::from_sdp_string(s.trim_start_matches("a=")) {
                                    Ok(c) => v.rtc.add_remote_candidate(c),
                                    Err(e) => warn!("bad candidate {s}: {e}"),
                                }
                            }
                            other => info!("unhandled signalling {:?}", other),
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    if !sid.is_empty() {
        send_raw(&mut con, &raw_line("stopstream", &[("id", sid)]));
        let _ = tokio::time::timeout(Duration::from_secs(1), con.events().next()).await;
    }
    Ok(())
}
