//! PHA-4499 phase 2: publish a Twitch / Kick / YouTube URL as a TS6 screen share.
//!
//! Efficiency model (zero decode, zero re-encode on the video path):
//!
//! * `yt-dlp` resolves the page URL to a direct H264 (`avc1`) media URL.
//! * One `ffmpeg` per stream copies the H264 bitstream out as Annex-B access
//!   units on a pipe (`-c:v copy`, ~no CPU) and encodes the audio to Opus
//!   once, sent as RTP to a loopback port.
//! * `str0m` (a sans-IO WebRTC stack, no libwebrtc) keeps one peer connection
//!   per viewer and fans the same access units out to all of them, so cost is
//!   one ffmpeg regardless of viewer count.
//! * ffmpeg only runs while at least one viewer is joined (plus a short grace
//!   period); an idle share costs nothing.
//!
//! The actor owns all of that and talks to the main connection loop through
//! channels: raw `notifystream*` lines come in as [`Ctl::Raw`], raw command
//! lines to send go out on `out_tx`. Signalling and the offer shape (H264
//! `640c1f` Constrained High + RTX, stream id `outgoing_video`, no inline
//! candidates) are the ones the phase 1 spike proved against TS6 desktop.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use bridge_proto::BridgeEvent;
use str0m::change::{SdpAnswer, SdpPendingOffer};
use str0m::format::Codec;
use str0m::media::{Direction, Frequency, MediaKind, MediaTime, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event as RtcEvent, IceConnectionState, Input, Output, Rtc};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::UdpSocket;
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, mpsc};
use tracing::{debug, info, warn};

const RETURN_CODE: &str = "4499";
/// Keep ffmpeg warm this long after the last viewer leaves (reload / re-watch).
const IDLE_GRACE: Duration = Duration::from_secs(10);
const SETUP_TIMEOUT: Duration = Duration::from_secs(20);
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(40);

#[derive(Clone, Debug)]
pub struct Config {
    /// LAN IP advertised as the ICE host candidate.
    pub ip: String,
    /// Optional second (public) IP for remote viewers; needs the UDP port forwarded.
    pub public_ip: Option<String>,
    pub port: u16,
    pub max_height: u32,
    pub viewer_limit: u32,
    /// Advertised bitrate in kbps (TS6 shows it; the real bitrate is the source's).
    pub bitrate_kbps: u32,
}

impl Config {
    pub fn from_env() -> Self {
        let get = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let num = |k: &str, d: u32| get(k).and_then(|v| v.trim().parse().ok()).unwrap_or(d);
        Self {
            ip: get("SEXTON_STREAM_IP").unwrap_or_else(|| "10.0.0.100".into()),
            public_ip: get("SEXTON_STREAM_PUBLIC_IP"),
            port: num("SEXTON_STREAM_PORT", 40000) as u16,
            max_height: num("SEXTON_STREAM_MAX_HEIGHT", 720),
            viewer_limit: num("SEXTON_STREAM_VIEWER_LIMIT", 8),
            bitrate_kbps: num("SEXTON_STREAM_BITRATE_KBPS", 4608),
        }
    }
}

/// Everything the actor reacts to.
pub enum Ctl {
    Start { url: String, title: Option<String> },
    Stop,
    Status,
    /// The TS session is up (or came back); `own_clid` is our client id.
    Connected { own_clid: u16 },
    /// The TS session died; any stream with it.
    Disconnected,
    /// A `notifystream*` / `notifyjoinstreamrequest` / `error` line from TS.
    Raw(String, HashMap<String, String>),
    Resolved(Result<Resolved, String>),
}

#[derive(Debug, Clone)]
pub struct Resolved {
    pub title: String,
    /// One URL (muxed) or two (video, audio).
    pub urls: Vec<String>,
}

// ---------------------------------------------------------------------------
// TS command-line helpers (shared with main.rs)
// ---------------------------------------------------------------------------

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

/// Parse a TS command line into (name, args).
pub fn parse_line(text: &str) -> (String, HashMap<String, String>) {
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

/// True for the incoming command names the stream actor wants.
pub fn is_stream_line(text: &str) -> bool {
    let name = text.split(|c| c == ' ' || c == '|').next().unwrap_or("");
    name.starts_with("notifystream")
        || name == "notifyjoinstreamrequest"
        || name == "notifyrespondjoinstreamrequest"
        || name == "notifyremovedfromstream"
        || (name == "error" && text.contains(&format!("return_code={RETURN_CODE}")))
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

// ---------------------------------------------------------------------------
// Source resolution + media pipeline
// ---------------------------------------------------------------------------

async fn resolve(url: &str, max_height: u32) -> Result<Resolved, String> {
    let fmt = format!(
        "bv*[vcodec^=avc1][height<={h}]+ba/b[vcodec^=avc1][height<={h}]/bv*[vcodec^=avc1]+ba/b[vcodec^=avc1]",
        h = max_height
    );
    let out = tokio::time::timeout(
        RESOLVE_TIMEOUT,
        Command::new("yt-dlp")
            .args(["--no-playlist", "--no-warnings", "-f", &fmt, "--print", "title", "--print", "urls", url])
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "yt-dlp timed out".to_string())?
    .map_err(|e| format!("yt-dlp: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("failed");
        return Err(last.trim_start_matches("ERROR: ").chars().take(200).collect());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let title = lines.next().unwrap_or("Stream").to_string();
    let urls: Vec<String> = lines.filter(|l| l.starts_with("http")).map(String::from).collect();
    if urls.is_empty() || urls.len() > 2 {
        return Err("no playable H264 source".into());
    }
    Ok(Resolved { title, urls })
}

struct Ffmpeg {
    child: Child,
    video_rx: mpsc::Receiver<Vec<u8>>,
    audio_rx: mpsc::Receiver<(u32, Vec<u8>)>,
    t0: Instant,
    audio_base: Option<u32>,
}

fn find_aud(buf: &[u8], from: usize) -> Option<usize> {
    let mut i = from;
    while i + 4 < buf.len() {
        if buf[i] == 0 && buf[i + 1] == 0 && buf[i + 2] == 1 {
            if buf[i + 3] & 0x1f == 9 {
                return Some(if i > 0 && buf[i - 1] == 0 { i - 1 } else { i });
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    None
}

fn is_idr(au: &[u8]) -> bool {
    au.windows(4).any(|w| w[0] == 0 && w[1] == 0 && w[2] == 1 && w[3] & 0x1f == 5)
}

async fn start_ffmpeg(r: &Resolved) -> Result<Ffmpeg> {
    let audio_sock = UdpSocket::bind("127.0.0.1:0").await?;
    let audio_port = audio_sock.local_addr()?.port();
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "warning", "-nostdin", "-re"]);
    for u in &r.urls {
        cmd.args(["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-i", u]);
    }
    let audio_in = if r.urls.len() == 2 { "1:a:0" } else { "0:a:0?" };
    cmd.args([
        "-map", "0:v:0", "-c:v", "copy",
        "-bsf:v", "h264_mp4toannexb,dump_extra=freq=keyframe,h264_metadata=aud=insert",
        "-f", "h264", "pipe:1",
        "-map", audio_in, "-vn", "-c:a", "libopus", "-b:a", "96k", "-ar", "48000", "-ac", "2",
        "-frame_duration", "20", "-application", "lowdelay",
        "-f", "rtp", "-payload_type", "111", "-sdp_file", "/dev/null",
        &format!("rtp://127.0.0.1:{audio_port}"),
    ]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| anyhow!("spawn ffmpeg: {e}"))?;
    let mut stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| anyhow!("no stderr"))?;

    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            warn!("ffmpeg: {l}");
        }
    });

    let (vtx, video_rx) = mpsc::channel::<Vec<u8>>(120);
    tokio::spawn(async move {
        let mut buf: Vec<u8> = Vec::with_capacity(1 << 20);
        let mut chunk = vec![0u8; 64 * 1024];
        let mut scan = 0usize;
        loop {
            match stdout.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
            // Emit every complete AU (up to the next AUD).
            loop {
                let Some(first) = find_aud(&buf, scan) else { break };
                let Some(next) = find_aud(&buf, first + 4) else {
                    scan = first;
                    break;
                };
                let au: Vec<u8> = buf[first..next].to_vec();
                buf.drain(..next);
                scan = 0;
                // Backpressure by dropping: a stalled consumer must not grow memory.
                if vtx.try_send(au).is_err() {
                    debug!("video AU dropped (consumer behind)");
                }
            }
        }
    });

    let (atx, audio_rx) = mpsc::channel::<(u32, Vec<u8>)>(200);
    tokio::spawn(async move {
        let mut b = vec![0u8; 2048];
        while let Ok((n, _)) = audio_sock.recv_from(&mut b).await {
            if n > 12 {
                let ts = u32::from_be_bytes([b[4], b[5], b[6], b[7]]);
                let _ = atx.try_send((ts, b[12..n].to_vec()));
            }
        }
    });

    Ok(Ffmpeg { child, video_rx, audio_rx, t0: Instant::now(), audio_base: None })
}

// ---------------------------------------------------------------------------
// The actor
// ---------------------------------------------------------------------------

struct Viewer {
    rtc: Rtc,
    mid_v: Mid,
    mid_a: Mid,
    pending: Option<SdpPendingOffer>,
    connected: bool,
    wait_idr: bool,
}

#[derive(PartialEq, Clone, Copy)]
enum Phase {
    Idle,
    Resolving,
    AwaitingStart,
    Live,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Resolving => "resolving",
            Phase::AwaitingStart => "starting",
            Phase::Live => "live",
        }
    }
}

struct Actor {
    cfg: Config,
    out_tx: mpsc::UnboundedSender<String>,
    event_tx: broadcast::Sender<BridgeEvent>,
    ctl_tx: mpsc::UnboundedSender<Ctl>,
    own_clid: Option<u16>,
    phase: Phase,
    phase_since: Instant,
    url: String,
    title: String,
    resolved: Option<Resolved>,
    sid: String,
    viewers: HashMap<String, Viewer>,
    ff: Option<Ffmpeg>,
    idle_since: Option<Instant>,
    started: Option<Instant>,
    local: Vec<SocketAddr>,
}

pub fn spawn(
    cfg: Config,
    out_tx: mpsc::UnboundedSender<String>,
    event_tx: broadcast::Sender<BridgeEvent>,
) -> mpsc::UnboundedSender<Ctl> {
    let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
    let tx = ctl_tx.clone();
    tokio::spawn(async move {
        if let Err(e) = run(cfg, ctl_rx, tx, out_tx, event_tx).await {
            warn!(error = %e, "stream actor exited");
        }
    });
    ctl_tx
}

async fn run(
    cfg: Config,
    mut ctl_rx: mpsc::UnboundedReceiver<Ctl>,
    ctl_tx: mpsc::UnboundedSender<Ctl>,
    out_tx: mpsc::UnboundedSender<String>,
    event_tx: broadcast::Sender<BridgeEvent>,
) -> Result<()> {
    let sock = UdpSocket::bind(("0.0.0.0", cfg.port)).await?;
    let mut local: Vec<SocketAddr> = vec![format!("{}:{}", cfg.ip, cfg.port).parse()?];
    if let Some(p) = &cfg.public_ip {
        local.push(format!("{}:{}", p, cfg.port).parse()?);
    }
    info!(port = cfg.port, "stream actor ready (idle)");
    let mut a = Actor {
        cfg,
        out_tx,
        event_tx,
        ctl_tx,
        own_clid: None,
        phase: Phase::Idle,
        phase_since: Instant::now(),
        url: String::new(),
        title: String::new(),
        resolved: None,
        sid: String::new(),
        viewers: HashMap::new(),
        ff: None,
        idle_since: None,
        started: None,
        local,
    };
    let mut buf = vec![0u8; 2000];

    loop {
        // Drain every viewer's outputs; find the nearest str0m timeout.
        let mut next = Instant::now() + Duration::from_millis(500);
        for (clid, v) in a.viewers.iter_mut() {
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
                        RtcEvent::Connected => info!(%clid, "viewer DTLS connected"),
                        RtcEvent::IceConnectionStateChange(s) => {
                            info!(%clid, state = ?s, "viewer ice");
                            v.connected = matches!(s, IceConnectionState::Connected | IceConnectionState::Completed);
                        }
                        RtcEvent::KeyframeRequest(_) => debug!(%clid, "PLI/FIR (waiting for next natural IDR)"),
                        _ => {}
                    },
                    Err(e) => {
                        warn!(%clid, "rtc error: {e}");
                        break;
                    }
                }
            }
        }
        // Drop viewers whose peer connection died.
        a.viewers.retain(|_, v| v.rtc.is_alive());

        enum Ev {
            Ctl(Option<Ctl>),
            Udp(std::io::Result<(usize, SocketAddr)>),
            Video(Option<Vec<u8>>),
            Audio(Option<(u32, Vec<u8>)>),
            Tick,
        }
        let sleep = tokio::time::sleep_until(tokio::time::Instant::from_std(next));
        let ev = {
            let (vrx, arx) = match a.ff.as_mut() {
                Some(f) => (Some(&mut f.video_rx), Some(&mut f.audio_rx)),
                None => (None, None),
            };
            tokio::select! {
                c = ctl_rx.recv() => Ev::Ctl(c),
                r = sock.recv_from(&mut buf) => Ev::Udp(r),
                v = async { match vrx { Some(r) => r.recv().await, None => std::future::pending().await } } => Ev::Video(v),
                x = async { match arx { Some(r) => r.recv().await, None => std::future::pending().await } } => Ev::Audio(x),
                _ = sleep => Ev::Tick,
            }
        };

        match ev {
            Ev::Ctl(None) => return Ok(()),
            Ev::Ctl(Some(c)) => a.on_ctl(c).await,
            Ev::Udp(Ok((n, src))) => {
                let now = Instant::now();
                for dest in &a.local {
                    if let Ok(contents) = (&buf[..n]).try_into() {
                        let input = Input::Receive(now, Receive { proto: Protocol::Udp, source: src, destination: *dest, contents });
                        if let Some(v) = a.viewers.values_mut().find(|v| v.rtc.accepts(&input)) {
                            let _ = v.rtc.handle_input(input);
                            break;
                        }
                    }
                }
            }
            Ev::Udp(Err(e)) => warn!("udp: {e}"),
            Ev::Video(Some(au)) => a.on_video(au),
            Ev::Audio(Some((ts, pkt))) => a.on_audio(ts, pkt),
            Ev::Video(None) | Ev::Audio(None) => {
                // ffmpeg closed a pipe: the source ended (or died).
                if a.ff.is_some() && a.phase == Phase::Live {
                    let why = "source ended";
                    a.finish(true, why).await;
                } else {
                    a.kill_ffmpeg().await;
                }
            }
            Ev::Tick => {
                let now = Instant::now();
                for v in a.viewers.values_mut() {
                    let _ = v.rtc.handle_input(Input::Timeout(now));
                }
                a.on_tick().await;
            }
        }
    }
}

impl Actor {
    fn emit(&self, action: &'static str, ok: bool, detail: impl Into<String>) {
        let _ = self.event_tx.send(BridgeEvent::ModerationResult { action, ok, detail: detail.into() });
    }

    fn send(&self, name: &str, args: &[(&str, String)]) {
        let line = raw_line(name, args);
        debug!(">> {}", &line[..line.len().min(160)]);
        let _ = self.out_tx.send(line);
    }

    fn set_phase(&mut self, p: Phase) {
        self.phase = p;
        self.phase_since = Instant::now();
    }

    fn status_json(&self) -> String {
        serde_json::json!({
            "active": self.phase != Phase::Idle,
            "state": self.phase.name(),
            "title": self.title,
            "url": self.url,
            "viewers": self.viewers.values().filter(|v| v.connected).count(),
            "joining": self.viewers.len(),
            "ffmpeg": self.ff.is_some(),
            "uptimeSecs": self.started.map(|s| s.elapsed().as_secs()).unwrap_or(0),
            "maxHeight": self.cfg.max_height,
            "viewerLimit": self.cfg.viewer_limit,
        })
        .to_string()
    }

    async fn kill_ffmpeg(&mut self) {
        if let Some(mut f) = self.ff.take() {
            let _ = f.child.start_kill();
            let _ = f.child.wait().await;
            info!("ffmpeg stopped");
        }
    }

    /// Tear the whole share down. `notify` also emits the stop event.
    async fn finish(&mut self, notify: bool, why: &str) {
        self.kill_ffmpeg().await;
        if !self.sid.is_empty() {
            self.send("stopstream", &[("id", self.sid.clone())]);
        }
        self.viewers.clear();
        self.sid.clear();
        self.resolved = None;
        self.started = None;
        self.idle_since = None;
        let was = self.phase;
        self.set_phase(Phase::Idle);
        if notify && was != Phase::Idle {
            self.emit("stream_stop", true, why);
        }
    }

    async fn on_ctl(&mut self, c: Ctl) {
        match c {
            Ctl::Connected { own_clid } => self.own_clid = Some(own_clid),
            Ctl::Disconnected => {
                self.own_clid = None;
                self.sid.clear(); // session is gone; nothing to stopstream
                self.finish(true, "connection lost").await;
            }
            Ctl::Status => self.emit("stream_status", true, self.status_json()),
            Ctl::Stop => {
                if self.phase == Phase::Idle {
                    self.emit("stream_stop", true, "nothing was streaming");
                } else {
                    self.finish(true, "stopped").await;
                }
            }
            Ctl::Start { url, title } => {
                if self.own_clid.is_none() {
                    self.emit("stream_start", false, "not connected to TeamSpeak");
                    return;
                }
                if self.phase != Phase::Idle {
                    self.finish(false, "replaced").await;
                }
                self.url = url.clone();
                self.title = title.unwrap_or_default();
                self.set_phase(Phase::Resolving);
                let (tx, h) = (self.ctl_tx.clone(), self.cfg.max_height);
                tokio::spawn(async move {
                    let _ = tx.send(Ctl::Resolved(resolve(&url, h).await));
                });
            }
            Ctl::Resolved(res) => {
                if self.phase != Phase::Resolving {
                    return; // superseded by stop / new start
                }
                match res {
                    Err(e) => {
                        self.set_phase(Phase::Idle);
                        self.emit("stream_start", false, format!("could not resolve: {e}"));
                    }
                    Ok(r) => {
                        if self.title.is_empty() {
                            self.title = r.title.clone();
                        }
                        let name: String = self.title.chars().take(60).collect();
                        self.resolved = Some(r);
                        self.set_phase(Phase::AwaitingStart);
                        self.send(
                            "setupstream",
                            &[
                                ("name", name),
                                ("type", "3".into()),
                                ("accessibility", "1".into()),
                                ("mode", "1".into()),
                                ("bitrate", self.cfg.bitrate_kbps.to_string()),
                                ("viewer_limit", self.cfg.viewer_limit.to_string()),
                                ("audio", "1".into()),
                                ("return_code", RETURN_CODE.into()),
                            ],
                        );
                    }
                }
            }
            Ctl::Raw(name, args) => self.on_raw(name, args).await,
        }
    }

    async fn on_raw(&mut self, name: String, a: HashMap<String, String>) {
        debug!("<< {} {:?}", name, a.iter().filter(|(k, _)| *k != "offer" && *k != "json").collect::<Vec<_>>());
        match name.as_str() {
            "error" => {
                let msg = a.get("msg").map(|s| s.as_str()).unwrap_or("");
                if self.phase == Phase::AwaitingStart && msg != "ok" {
                    self.set_phase(Phase::Idle);
                    self.emit("stream_start", false, format!("server refused stream: {msg}"));
                }
            }
            "notifystreamstarted" if self.own_clid.map(|c| c.to_string()) == a.get("clid").cloned() => {
                if self.phase == Phase::AwaitingStart {
                    self.sid = a.get("id").cloned().unwrap_or_default();
                    self.started = Some(Instant::now());
                    self.set_phase(Phase::Live);
                    info!(sid = %self.sid, title = %self.title, "stream live");
                    self.emit("stream_start", true, self.status_json());
                }
            }
            "notifyjoinstreamrequest" if self.phase == Phase::Live => {
                let clid = a.get("clid").cloned().unwrap_or_default();
                if a.get("is_remove").map(|s| s.as_str()) == Some("1") {
                    self.viewers.remove(&clid);
                    return;
                }
                if let Err(e) = self.add_viewer(clid.clone()) {
                    warn!(%clid, "add viewer failed: {e}");
                }
            }
            "notifystreamclientleft" | "notifyremovedfromstream" => {
                if let Some(c) = a.get("clid") {
                    self.viewers.remove(c);
                }
            }
            "notifystreamsignaling" => {
                let clid = a.get("clid").cloned().unwrap_or_default();
                let Some(v) = self.viewers.get_mut(&clid) else { return };
                let j: serde_json::Value =
                    serde_json::from_str(a.get("json").map(|s| s.as_str()).unwrap_or("{}")).unwrap_or_default();
                match j["cmd"].as_str() {
                    Some("answer") => {
                        let s = j["args"]["answer"].as_str().or(j["args"]["sdp"].as_str()).unwrap_or("");
                        match (SdpAnswer::from_sdp_string(s), v.pending.take()) {
                            (Ok(ans), Some(p)) => {
                                if let Err(e) = v.rtc.sdp_api().accept_answer(p, ans) {
                                    warn!(%clid, "accept_answer: {e}");
                                }
                            }
                            (Err(e), _) => warn!(%clid, "bad answer: {e}"),
                            _ => {}
                        }
                    }
                    Some("iceCandidate") => {
                        let s = j["args"]["sdp"].as_str().unwrap_or("");
                        match Candidate::from_sdp_string(s.trim_start_matches("a=")) {
                            Ok(c) => v.rtc.add_remote_candidate(c),
                            Err(e) => debug!(%clid, "bad candidate {s}: {e}"),
                        }
                    }
                    other => debug!(%clid, "unhandled signalling {:?}", other),
                }
            }
            other if other.starts_with("notifystream") => debug!("unhandled {other}"),
            _ => {}
        }
    }

    fn add_viewer(&mut self, clid: String) -> Result<()> {
        let mut cfg = Rtc::builder().clear_codecs().enable_opus(true, false);
        // 0x640c1f = Constrained High. Baseline crashes TS6 desktop; plain High
        // (64001f) is rejected by it. See phase 1 spike notes on PHA-4499.
        cfg.codec_config().add_h264(102.into(), Some(103.into()), true, 0x640c1f);
        let mut rtc = cfg.build(Instant::now());
        let mut cands = vec![];
        for l in &self.local {
            let c = Candidate::host(*l, "udp").map_err(|e| anyhow!("{e}"))?;
            cands.push(c.to_sdp_string());
            rtc.add_local_candidate(c);
        }
        let mut api = rtc.sdp_api();
        let mid_v = api.add_media(MediaKind::Video, Direction::SendOnly, Some("outgoing_video".into()), None, None);
        let mid_a = api.add_media(MediaKind::Audio, Direction::SendOnly, Some("outgoing_video".into()), None, None);
        let (offer, pending) = api.apply().ok_or_else(|| anyhow!("no offer"))?;
        let sdp = offer
            .to_sdp_string()
            .lines()
            .filter(|l| !l.starts_with("a=candidate:") && !l.starts_with("a=end-of-candidates"))
            .collect::<Vec<_>>()
            .join("\r\n")
            + "\r\n";
        self.send(
            "respondjoinstreamrequest",
            &[
                ("id", self.sid.clone()),
                ("clid", clid.clone()),
                ("decision", "1".into()),
                ("offer", sdp),
                ("msg", String::new()),
            ],
        );
        for c in cands {
            let cs = c.trim_start_matches("a=");
            let json = format!(r#"{{"cmd":"iceCandidate","args":{{"mLine":0,"mid":"0","sdp":"{cs}"}}}}"#);
            self.send("streamsignaling", &[("id", self.sid.clone()), ("clid", clid.clone()), ("json", json)]);
        }
        self.viewers.insert(
            clid,
            Viewer { rtc, mid_v, mid_a, pending: Some(pending), connected: false, wait_idr: true },
        );
        self.idle_since = None;
        Ok(())
    }

    fn on_video(&mut self, au: Vec<u8>) {
        let Some(f) = self.ff.as_ref() else { return };
        let idr = is_idr(&au);
        let now = Instant::now();
        let ts = (now.duration_since(f.t0).as_micros() as u64) * 9 / 100; // 90 kHz
        for v in self.viewers.values_mut().filter(|v| v.connected) {
            if v.wait_idr && !idr {
                continue;
            }
            v.wait_idr = false;
            let Some(w) = v.rtc.writer(v.mid_v) else { continue };
            let Some(pt) = w.payload_params().find(|p| p.spec().codec == Codec::H264).map(|p| p.pt()) else { continue };
            if let Err(e) = w.write(pt, now, MediaTime::new(ts, Frequency::NINETY_KHZ), au.clone()) {
                warn!("video write: {e}");
            }
        }
    }

    fn on_audio(&mut self, rtp_ts: u32, pkt: Vec<u8>) {
        let Some(f) = self.ff.as_mut() else { return };
        let base = *f.audio_base.get_or_insert(rtp_ts);
        let ts = rtp_ts.wrapping_sub(base) as u64;
        let now = Instant::now();
        for v in self.viewers.values_mut().filter(|v| v.connected && !v.wait_idr) {
            let Some(w) = v.rtc.writer(v.mid_a) else { continue };
            let Some(pt) = w.payload_params().find(|p| p.spec().codec == Codec::Opus).map(|p| p.pt()) else { continue };
            if let Err(e) = w.write(pt, now, MediaTime::new(ts, Frequency::FORTY_EIGHT_KHZ), pkt.clone()) {
                debug!("audio write: {e}");
            }
        }
    }

    async fn on_tick(&mut self) {
        match self.phase {
            Phase::Resolving if self.phase_since.elapsed() > RESOLVE_TIMEOUT + Duration::from_secs(5) => {
                self.set_phase(Phase::Idle);
                self.emit("stream_start", false, "resolve timed out");
            }
            Phase::AwaitingStart if self.phase_since.elapsed() > SETUP_TIMEOUT => {
                self.set_phase(Phase::Idle);
                self.emit("stream_start", false, "server never confirmed the stream");
            }
            Phase::Live => {
                // Lazy start: ffmpeg only runs while someone is (about to be) watching.
                if !self.viewers.is_empty() {
                    self.idle_since = None;
                    if self.ff.is_none() {
                        if let Some(r) = self.resolved.clone() {
                            match start_ffmpeg(&r).await {
                                Ok(f) => {
                                    info!("ffmpeg started (first viewer)");
                                    self.ff = Some(f);
                                }
                                Err(e) => {
                                    warn!("ffmpeg start failed: {e}");
                                    self.finish(true, &format!("ffmpeg failed: {e}")).await;
                                }
                            }
                        }
                    }
                } else if self.ff.is_some() {
                    let since = *self.idle_since.get_or_insert_with(Instant::now);
                    if since.elapsed() > IDLE_GRACE {
                        info!("no viewers; stopping ffmpeg");
                        self.kill_ffmpeg().await;
                        self.idle_since = None;
                    }
                }
            }
            _ => {}
        }
    }
}
