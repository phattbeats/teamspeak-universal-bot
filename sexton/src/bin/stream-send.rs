//! PHA-3289 stream *sender* probe: the mirror of stream-watch.
//!
//! Joins a channel, starts a TS6 screen share with `setupstream`, and for every
//! `notifyjoinstreamrequest` spawns a Python/aiortc sender (test pattern) whose
//! offer goes back in `respondjoinstreamrequest ... decision=1 offer=`. The
//! viewer's answer and ICE arrive as `notifystreamsignaling` and are piped to
//! that sender; the sender's candidates trickle out as `iceCandidate` messages.
//! Proves the phone-sends-to-desktop path before any Android code.

use std::collections::HashMap;
use std::io::Write as _;
use std::process::Stdio;
use std::time::{Duration as StdDuration, Instant};

use anyhow::{anyhow, Result};
use clap::Parser;
use futures::prelude::*;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

use tsclientlib::messages::c2s::{OutClientMoveMessage, OutClientMovePart};
use tsclientlib::prelude::*;
use tsclientlib::{ChannelId, ClientId, Connection, Identity, StreamItem};
use tsproto::connection::Event as RawEvent;
use tsproto_packets::packets::{Direction, Flags, OutCommand, PacketType};

#[derive(Parser, Debug)]
struct Args {
    #[arg(short = 'a', long, default_value = "teamspeak6-server:9987")]
    address: String,
    #[arg(short = 'n', long, default_value = "PLNT stream sender")]
    nickname: String,
    #[arg(short = 'c', long, default_value = "Lobby")]
    channel: String,
    #[arg(long, default_value = "PLNT test pattern")]
    stream_name: String,
    #[arg(long, default_value = "/data/send/identity.txt")]
    identity_file: String,
    #[arg(long, default_value = "/data/send.log")]
    log_file: String,
    #[arg(long, env = "SENDER_PY", default_value = "python3")]
    sender_py: String,
    #[arg(long, env = "SENDER_SCRIPT", default_value = "/data/watch/sender.py")]
    sender_script: String,
    /// Extra args handed to every sender (e.g. "--codec vp8 --audio-mline").
    #[arg(long, default_value = "--audio-mline")]
    sender_args: String,
    /// How long the stream stays up before stopstream + exit.
    #[arg(long, default_value_t = 600)]
    seconds: u64,
    #[arg(long, default_value_t = 150)]
    cmd_gap_ms: u64,
}

struct Log(std::fs::File);
impl Log {
    fn line(&mut self, tag: &str, s: &str) {
        let ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let _ = writeln!(self.0, "{ts} {tag} {s}");
        let _ = self.0.flush();
        println!("{ts} {tag} {}", s.chars().take(300).collect::<String>());
    }
}

fn unescape(v: &str) -> String {
    let mut o = String::new();
    let mut it = v.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            match it.next() {
                Some('s') => o.push(' '),
                Some('p') => o.push('|'),
                Some('/') => o.push('/'),
                Some('n') => o.push('\n'),
                Some('r') => o.push('\r'),
                Some('t') => o.push('\t'),
                Some(x) => o.push(x),
                None => {}
            }
        } else {
            o.push(c)
        }
    }
    o
}

fn ts_escape(v: &str) -> String {
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

fn parse_first(raw: &str) -> (String, HashMap<String, String>) {
    let first = raw.split('|').next().unwrap_or("");
    let mut name = String::new();
    let mut m = HashMap::new();
    for (i, tok) in first.split(' ').enumerate() {
        if i == 0 && !tok.contains('=') {
            name = tok.to_string();
            continue;
        }
        if tok.is_empty() {
            continue;
        }
        let (k, v) = tok.split_once('=').unwrap_or((tok, ""));
        m.insert(k.to_string(), unescape(v));
    }
    (name, m)
}

fn load_identity(path: &str) -> Result<Identity> {
    if let Ok(s) = std::fs::read_to_string(path) {
        if !s.trim().is_empty() {
            return Identity::new_from_str(s.trim()).map_err(|e| anyhow!("identity: {e:?}"));
        }
    }
    if let Some(p) = std::path::Path::new(path).parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let id = Identity::create();
    std::fs::write(path, format!("{}V{}", id.counter(), id.key().to_ts()))?;
    Ok(id)
}

struct Peer {
    stdin: ChildStdin,
    _child: Child,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let f = std::fs::OpenOptions::new().create(true).append(true).open(&args.log_file)?;
    let mut log = Log(f);
    let identity = load_identity(&args.identity_file)?;
    log.line("INFO", &format!("connecting to {} as {:?}", args.address, args.nickname));
    let mut con = Connection::build(args.address.clone())
        .identity(identity)
        .name(args.nickname.clone())
        .connect()
        .map_err(|e| anyhow!("connect: {e}"))?;
    loop {
        match tokio::time::timeout(StdDuration::from_secs(30), con.events().next()).await {
            Ok(Some(Ok(StreamItem::BookEvents(_)))) => break,
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(anyhow!("connect wait: {e}")),
            Ok(None) => return Err(anyhow!("stream ended before connect")),
            Err(_) => return Err(anyhow!("connect timeout")),
        }
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    {
        let raw = con.get_tsproto_client_mut().map_err(|e| anyhow!("raw client: {e}"))?;
        raw.event_listeners.push(Box::new(move |ev: &RawEvent| {
            if let RawEvent::ReceivePacket(p) = ev {
                if p.header().packet_type().is_command() {
                    let _ = tx.send(String::from_utf8_lossy(p.content()).into_owned());
                }
            }
        }));
    }
    let own: ClientId = con.get_state().map_err(|e| anyhow!("{e}"))?.own_client;
    log.line("INFO", &format!("connected, own clid={}", own.0));

    let (child_tx, mut child_rx) = mpsc::unbounded_channel::<(u16, String)>();
    let mut queue: Vec<String> = Vec::new();
    let mut last_send = Instant::now();
    let mut chan: Option<ChannelId> = None;
    let mut setup_sent = false;
    let mut sid: Option<String> = None;
    let mut peers: HashMap<u16, Peer> = HashMap::new();
    let mut deadline: Option<Instant> = None;

    loop {
        match tokio::time::timeout(StdDuration::from_millis(50), con.events().next()).await {
            Ok(Some(Ok(StreamItem::DisconnectedTemporarily(r)))) => {
                return Err(anyhow!("disconnected: {r:?}"));
            }
            Ok(Some(Err(e))) => return Err(anyhow!("event stream: {e}")),
            Ok(None) => return Ok(()),
            _ => {}
        }

        if chan.is_none() {
            let cid = con
                .get_state()
                .map_err(|e| anyhow!("{e}"))?
                .channels
                .iter()
                .find(|(_, c)| c.name == args.channel)
                .map(|(id, _)| *id);
            if let Some(cid) = cid {
                OutClientMoveMessage::new(&mut std::iter::once(OutClientMovePart {
                    client_id: own,
                    channel_id: cid,
                    channel_password: None,
                }))
                .send(&mut con)
                .map_err(|e| anyhow!("{e}"))?;
                chan = Some(cid);
                last_send = Instant::now();
                log.line("INFO", &format!("moved to {:?}", args.channel));
            }
        } else if !setup_sent && last_send.elapsed() > StdDuration::from_millis(800) {
            // `accessibility` is the field the server insists on; `access` is
            // what it echoes back in notifystreamstarted.
            queue.push(format!(
                "setupstream name={} type=3 accessibility=1 mode=1 bitrate=4608 viewer_limit=0 audio=0",
                ts_escape(&args.stream_name)
            ));
            setup_sent = true;
            deadline = Some(Instant::now() + StdDuration::from_secs(args.seconds));
        }

        while let Ok(text) = rx.try_recv() {
            let (name, m) = parse_first(&text);
            let interesting = name.starts_with("notifystream")
                || name.starts_with("notifyjoinstream")
                || name == "error";
            if interesting {
                log.line("IN", &text);
            }
            if name == "notifystreamstarted"
                && m.get("clid").map(|c| c == &own.0.to_string()).unwrap_or(false)
            {
                sid = m.get("id").cloned();
                log.line("INFO", &format!("our stream is live: id={sid:?}"));
            }
            if name == "notifyjoinstreamrequest" {
                let clid = m.get("clid").and_then(|c| c.parse::<u16>().ok()).unwrap_or(0);
                let removing = m.get("is_remove").map(|v| v == "1").unwrap_or(false);
                let id = m.get("id").cloned().or_else(|| sid.clone()).unwrap_or_default();
                if removing {
                    if peers.remove(&clid).is_some() {
                        log.line("INFO", &format!("viewer clid={clid} left"));
                    }
                } else if !peers.contains_key(&clid) {
                    match spawn_sender(&args, &child_tx, clid, &id).await {
                        Ok(p) => {
                            peers.insert(clid, p);
                            log.line("INFO", &format!("viewer clid={clid} asked to join -> sender spawned"));
                        }
                        Err(e) => log.line("WARN", &format!("spawn sender: {e}")),
                    }
                }
            }
            if name == "notifystreamsignaling" {
                let clid = m.get("clid").and_then(|c| c.parse::<u16>().ok()).unwrap_or(0);
                if let (Some(peer), Some(js)) = (peers.get_mut(&clid), m.get("json")) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(js) {
                        let cmd = v.get("cmd").and_then(|c| c.as_str()).unwrap_or("");
                        let a = &v["args"];
                        let line = match cmd {
                            "answer" => Some(json!({"type": "answer",
                                "sdp": a.get("answer").or_else(|| a.get("sdp")).and_then(|x| x.as_str()).unwrap_or("")})),
                            "offer" => Some(json!({"type": "offer",
                                "sdp": a.get("offer").and_then(|x| x.as_str()).unwrap_or("")})),
                            "iceCandidate" => Some(json!({"type": "candidate",
                                "candidate": a.get("sdp").and_then(|x| x.as_str()).unwrap_or(""),
                                "mid": a.get("mid").and_then(|x| x.as_str()),
                                "mLine": a.get("mLine").and_then(|x| x.as_i64()).unwrap_or(0)})),
                            _ => {
                                log.line("INFO", &format!("viewer signaling cmd={cmd}: {v}"));
                                None
                            }
                        };
                        if let Some(l) = line {
                            let _ = peer.stdin.write_all(format!("{l}\n").as_bytes()).await;
                            let _ = peer.stdin.flush().await;
                        }
                    }
                }
            }
        }

        while let Ok((clid, line)) = child_rx.try_recv() {
            if let Some(rest) = line.strip_prefix("__ERR__") {
                log.line("PYERR", rest);
                continue;
            }
            if line == "__EOF__" {
                peers.remove(&clid);
                log.line("INFO", &format!("sender for clid={clid} exited"));
                continue;
            }
            let v: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => {
                    log.line("PY", &line);
                    continue;
                }
            };
            let id = sid.clone().unwrap_or_default();
            match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "offer" => {
                    let sdp = v["sdp"].as_str().unwrap_or("").to_string();
                    // Real TS6 streamers put no candidates in the offer; they
                    // arrive only as separate iceCandidate messages. Sending
                    // both duplicated every candidate.
                    let bare: String = sdp
                        .split("\r\n")
                        .filter(|l| !l.starts_with("a=candidate:") && !l.starts_with("a=end-of-candidates"))
                        .collect::<Vec<_>>()
                        .join("\r\n");
                    let mut front = vec![format!(
                        "respondjoinstreamrequest id={} clid={clid} decision=1 offer={} msg=",
                        ts_escape(&id),
                        ts_escape(&bare)
                    )];
                    front.extend(trickle(&id, clid, &sdp));
                    log.line("INFO", &format!("offer for clid={clid}: {} bytes, {} trickled candidates", sdp.len(), front.len() - 1));
                    let rest = std::mem::take(&mut queue);
                    queue = front;
                    queue.extend(rest);
                }
                "answer" => {
                    let sdp = v["sdp"].as_str().unwrap_or("").to_string();
                    let payload = json!({"cmd": "answer", "args": {"answer": sdp}}).to_string();
                    queue.insert(0, format!("streamsignaling id={} clid={clid} json={}", ts_escape(&id), ts_escape(&payload)));
                }
                "log" => log.line("PY", &format!("[{clid}] {}", v["msg"].as_str().unwrap_or(""))),
                _ => log.line("PY", &format!("[{clid}] {v}")),
            }
        }

        if let Some(d) = deadline {
            if Instant::now() >= d {
                if let Some(id) = &sid {
                    let t = format!("stopstream id={} return_code=1", ts_escape(id));
                    let cmd = OutCommand::new(Direction::C2S, Flags::empty(), PacketType::Command, &t);
                    let _ = cmd.send(&mut con);
                    log.line("OUT", &t);
                    tokio::time::sleep(StdDuration::from_millis(500)).await;
                }
                log.line("INFO", "time up, exiting");
                return Ok(());
            }
        }

        if !queue.is_empty() && last_send.elapsed() >= StdDuration::from_millis(args.cmd_gap_ms) {
            let text = queue.remove(0);
            if text.len() > 8000 {
                log.line("WARN", &format!("command {} bytes exceeds ~8KB", text.len()));
            }
            let cmd = OutCommand::new(Direction::C2S, Flags::empty(), PacketType::Command, &text);
            cmd.send(&mut con).map_err(|e| anyhow!("send: {e}"))?;
            last_send = Instant::now();
            log.line("OUT", &text.chars().take(400).collect::<String>());
        }
    }
}

/// One `iceCandidate` streamsignaling message per a=candidate line, in the same
/// shape TS6 desktop clients trickle theirs.
fn trickle(sid: &str, clid: u16, sdp: &str) -> Vec<String> {
    let mut ufrag = String::new();
    for l in sdp.split("\r\n") {
        if let Some(u) = l.strip_prefix("a=ice-ufrag:") {
            ufrag = u.to_string();
            break;
        }
    }
    let mut out = Vec::new();
    let mut mline: i64 = -1;
    let mut mid = String::new();
    for l in sdp.split("\r\n") {
        if l.starts_with("m=") {
            mline += 1;
            mid = mline.to_string();
        } else if let Some(m) = l.strip_prefix("a=mid:") {
            mid = m.to_string();
        } else if let Some(c) = l.strip_prefix("a=") {
            if c.starts_with("candidate:") && mline == 0 {
                let line = format!("{c} generation 0 ufrag {ufrag} network-id 1");
                let payload = json!({"cmd": "iceCandidate", "args": {"mLine": 0, "mid": mid, "sdp": line}}).to_string();
                out.push(format!("streamsignaling id={} clid={clid} json={}", ts_escape(sid), ts_escape(&payload)));
            }
        }
    }
    out
}

async fn spawn_sender(
    args: &Args, child_tx: &mpsc::UnboundedSender<(u16, String)>, clid: u16, sid: &str,
) -> Result<Peer> {
    let mut cmd = Command::new(&args.sender_py);
    cmd.arg(&args.sender_script).arg("--sid").arg(sid).arg("--clid").arg(clid.to_string());
    for a in args.sender_args.split_whitespace() {
        cmd.arg(a);
    }
    let mut child = cmd
        .arg("--seconds")
        .arg(args.seconds.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| anyhow!("spawn {}: {e}", args.sender_py))?;
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let tx = child_tx.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            let _ = tx.send((clid, l));
        }
        let _ = tx.send((clid, "__EOF__".into()));
    });
    let tx2 = child_tx.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            let _ = tx2.send((clid, format!("__ERR__{l}")));
        }
    });
    Ok(Peer { stdin, _child: child })
}
