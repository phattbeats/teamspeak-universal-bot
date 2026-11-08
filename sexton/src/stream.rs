//! PHA-4499: publish videos and live streams as a TS6 screen share, with a
//! queue and saved playlists.
//!
//! Efficiency model (zero decode, zero re-encode on the video path):
//!
//! * `yt-dlp` resolves the page URL (any site it supports) to direct media
//!   URLs, preferring an H264 (`avc1`) variant under the height cap.
//! * One `ffmpeg` per share copies the H264 bitstream out as Annex-B access
//!   units on a pipe (`-c:v copy`, ~no CPU) and encodes the audio to Opus
//!   once, sent as RTP to a loopback port. Only a source with no H264 at all
//!   is transcoded (x264 veryfast, capped height/fps).
//! * `str0m` (a sans-IO WebRTC stack, no libwebrtc) keeps one peer connection
//!   per viewer and fans the same access units out to all of them, so cost is
//!   one ffmpeg regardless of viewer count.
//! * ffmpeg only runs while at least one viewer is joined (plus a short grace
//!   period); an idle share costs nothing, and a VOD resumes where it was.
//! * The share outlives a queue item: when one ends the next is swapped in
//!   under the same viewers (they wait for its first IDR), so nobody has to
//!   click Watch again. The next item is resolved ahead while one plays.
//!
//! The actor owns all of that and talks to the main connection loop through
//! channels: raw `notifystream*` lines come in as [`Ctl::Raw`], raw command
//! lines to send go out on `out_tx`. Signalling and the offer shape (H264
//! `640c1f` Constrained High + RTX, stream id `outgoing_video`, no inline
//! candidates) are the ones the phase 1 spike proved against TS6 desktop.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use bridge_proto::BridgeEvent;
use serde::{Deserialize, Serialize};
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
/// Resolved media URLs carry expiring tokens: live HLS ones go stale fast.
const TTL_LIVE: Duration = Duration::from_secs(5 * 60);
const TTL_VOD: Duration = Duration::from_secs(60 * 60);
/// Most entries one playlist link may add.
const PLAYLIST_MAX: usize = 50;
const QUEUE_MAX: usize = 200;

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
    /// Saved named playlists (shared by every bot in the container).
    pub playlists_file: String,
    /// End the share after this long without a video frame (no viewers, stalled source).
    pub no_video_stop: Duration,
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
            playlists_file: get("SEXTON_STREAM_PLAYLISTS").unwrap_or_else(|| "/config/stream-playlists.json".into()),
            no_video_stop: Duration::from_secs(num("SEXTON_STREAM_NO_VIDEO_SECS", 300).max(30) as u64),
        }
    }
}

/// Where a new request goes. Any of them plays at once when nothing is on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    /// End of the queue.
    Queue,
    /// Front of the queue.
    Next,
    /// Replace what is playing (the rest of the queue stays).
    Now,
}

impl Mode {
    pub fn parse(s: Option<&str>) -> Self {
        match s.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
            Some("now") | Some("replace") => Mode::Now,
            Some("next") => Mode::Next,
            _ => Mode::Queue,
        }
    }
}

pub struct QueueOp {
    pub op: String,
    /// 1-based queue position.
    pub index: Option<u32>,
    pub to: Option<u32>,
    pub name: Option<String>,
    pub mode: Mode,
}

/// A request that has been checked (resolved, or expanded from a playlist).
pub struct Entry {
    url: String,
    title: String,
    res: Option<Resolved>,
}

/// Everything the actor reacts to.
pub enum Ctl {
    Start { url: String, title: Option<String>, mode: Mode, playlist: bool },
    Stop,
    Status,
    Queue(QueueOp),
    /// The TS session is up (or came back); `own_clid` is our client id.
    Connected { own_clid: u16 },
    /// The TS session died; any stream with it.
    Disconnected,
    /// A `notifystream*` / `notifyjoinstreamrequest` / `error` line from TS.
    Raw(String, HashMap<String, String>),
    Resolved { id: u64, res: Result<Resolved, String> },
    Add { entries: Vec<Entry>, mode: Mode, action: &'static str },
    Fail { action: &'static str, detail: String },
}

#[derive(Debug, Clone)]
pub struct Resolved {
    pub title: String,
    /// One URL (muxed) or two (video, audio).
    pub urls: Vec<String>,
    /// The video is H264 and can be passed through untouched.
    pub copy: bool,
    pub live: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SavedItem {
    url: String,
    #[serde(default)]
    title: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SavedList {
    name: String,
    items: Vec<SavedItem>,
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

async fn ytdlp(args: &[&str]) -> Result<String, String> {
    let out = tokio::time::timeout(
        RESOLVE_TIMEOUT,
        Command::new("yt-dlp").args(args).stdin(Stdio::null()).kill_on_drop(true).output(),
    )
    .await
    .map_err(|_| "yt-dlp timed out".to_string())?
    .map_err(|e| format!("yt-dlp: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("failed");
        return Err(last.trim_start_matches("ERROR: ").chars().take(200).collect());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Retry form of a link: `vimeo.com/<id>` wants a login in yt-dlp, its player URL doesn't.
fn alt_url(url: &str) -> String {
    let id = url
        .split_once("vimeo.com/")
        .filter(|(host, _)| !host.contains("player."))
        .map(|(_, rest)| rest.chars().take_while(|c| c.is_ascii_digit()).collect::<String>())
        .filter(|id| !id.is_empty());
    match id {
        Some(id) => format!("https://player.vimeo.com/video/{id}"),
        None => url.to_string(),
    }
}

/// Plain first; on failure once more as a browser (Cloudflare fronts, e.g. Rumble)
/// and with any alternate URL.
async fn resolve(url: &str, max_height: u32) -> Result<Resolved, String> {
    match resolve_once(url, max_height, false).await {
        Ok(r) => Ok(r),
        Err(first) => {
            debug!("resolve failed ({first}); retrying as a browser");
            resolve_once(&alt_url(url), max_height, true).await.map_err(|_| first)
        }
    }
}

async fn resolve_once(url: &str, max_height: u32, impersonate: bool) -> Result<Resolved, String> {
    // H264 under the cap, then any H264 (passthrough beats a transcode), then
    // anything with video under the cap, then anything.
    let fmt = format!(
        "bv*[vcodec^=avc1][height<={h}]+ba/b[vcodec^=avc1][height<={h}]/bv*[vcodec^=avc1]+ba/b[vcodec^=avc1]\
         /bv*[height<=?{h}]+ba/b[height<=?{h}]/bv*+ba/b",
        h = max_height
    );
    let mut args = vec![
        "--no-playlist", "--no-warnings", "-f", &fmt,
        "--print", "%(title)s\x1f%(vcodec)s\x1f%(is_live)s",
        "--print", "urls",
    ];
    if impersonate {
        args.extend(["--impersonate", "chrome"]);
    }
    args.push(url);
    let text = ytdlp(&args).await?;
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let mut meta = lines.next().unwrap_or("").split('\x1f');
    let title = meta.next().filter(|t| !t.is_empty() && *t != "NA").unwrap_or("Stream").to_string();
    let vcodec = meta.next().unwrap_or("").to_ascii_lowercase();
    let live = meta.next() == Some("True");
    let urls: Vec<String> = lines.filter(|l| l.starts_with("http")).map(String::from).collect();
    if urls.is_empty() || urls.len() > 2 {
        return Err("no playable video in that link".into());
    }
    let copy = if vcodec.starts_with("avc") || vcodec.starts_with("h264") {
        true
    } else if vcodec.is_empty() || vcodec == "na" || vcodec == "none" || vcodec == "unknown" {
        // Some extractors (generic HLS, Rumble) don't say; ask the stream itself.
        probe_is_h264(&urls[0]).await
    } else {
        false
    };
    Ok(Resolved { title, urls, copy, live })
}

async fn probe_is_h264(url: &str) -> bool {
    let out = tokio::time::timeout(
        Duration::from_secs(15),
        Command::new("ffprobe")
            .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", url])
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await;
    matches!(out, Ok(Ok(o)) if String::from_utf8_lossy(&o.stdout).trim() == "h264")
}

/// Links that are a list rather than one video.
fn looks_like_playlist(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    let yt_list = u.contains("list=") && !u.contains("v=") && !u.contains("youtu.be/");
    yt_list
        || u.contains("/playlist")
        || u.contains("/showcase/")
        || u.contains("/album/")
        || u.contains("/collections/")
        || (u.contains("twitch.tv/") && u.contains("/videos"))
}

/// Flat-list a playlist into (url, title) entries without resolving each.
async fn expand_playlist(url: &str) -> Result<Vec<Entry>, String> {
    let end = PLAYLIST_MAX.to_string();
    let args = [
        "--flat-playlist", "--yes-playlist", "--no-warnings", "--playlist-end", &end,
        "--print", "%(webpage_url,url)s\x1f%(title)s",
    ];
    let text = match ytdlp(&[&args[..], &[url]].concat()).await {
        Ok(t) => t,
        Err(_) => ytdlp(&[&args[..], &["--impersonate", "chrome", url]].concat()).await?,
    };
    Ok(text
        .lines()
        .filter_map(|l| {
            let mut p = l.trim().split('\x1f');
            let u = p.next()?.trim();
            let t = p.next().unwrap_or("").trim();
            u.starts_with("http").then(|| Entry {
                url: u.to_string(),
                title: if t == "NA" { String::new() } else { t.to_string() },
                res: None,
            })
        })
        .collect())
}

struct Ffmpeg {
    child: Child,
    video_rx: mpsc::Receiver<Vec<u8>>,
    audio_rx: mpsc::Receiver<(u32, Vec<u8>)>,
    /// 48 kHz offset of this item on the share's clock (keeps RTP time monotonic across items).
    audio_offset: u64,
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

async fn start_ffmpeg(r: &Resolved, seek: Option<Duration>, max_height: u32, audio_offset: u64) -> Result<Ffmpeg> {
    let audio_sock = UdpSocket::bind("127.0.0.1:0").await?;
    let audio_port = audio_sock.local_addr()?.port();
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "warning", "-nostdin", "-re"]);
    let ss = seek.map(|s| format!("{:.1}", s.as_secs_f64()));
    for u in &r.urls {
        if let Some(ss) = &ss {
            cmd.args(["-ss", ss]);
        }
        cmd.args(["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-i", u]);
    }
    let audio_in = if r.urls.len() == 2 { "1:a:0" } else { "0:a:0?" };
    cmd.args(["-map", "0:v:0"]);
    if r.copy {
        cmd.args(["-c:v", "copy", "-bsf:v", "h264_mp4toannexb,dump_extra=freq=keyframe,h264_metadata=aud=insert"]);
    } else {
        // Fallback for non-H264 sources only: the one place we spend CPU on video.
        let vf = format!("scale=-2:'min({max_height},ih)':flags=fast_bilinear,format=yuv420p");
        cmd.args([
            "-vf", &vf, "-fpsmax", "30", "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
            "-profile:v", "high", "-bf", "0", "-g", "60", "-b:v", "3000k", "-maxrate", "3500k", "-bufsize", "6000k",
            "-x264-params", "repeat-headers=1", "-bsf:v", "h264_metadata=aud=insert",
        ]);
    }
    cmd.args([
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

    Ok(Ffmpeg { child, video_rx, audio_rx, audio_offset, audio_base: None })
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

/// One queue entry.
struct Item {
    id: u64,
    url: String,
    title: String,
    res: Option<(Resolved, Instant)>,
    resolving: bool,
    /// How much of a VOD has been shown, for resuming after an idle stop.
    played: Duration,
}

impl Item {
    fn fresh(&self) -> bool {
        self.res.as_ref().is_some_and(|(r, at)| at.elapsed() < if r.live { TTL_LIVE } else { TTL_VOD })
    }

    fn label(&self) -> String {
        if self.title.is_empty() { self.url.clone() } else { self.title.clone() }
    }

    fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "title": self.label(),
            "url": self.url,
            "live": self.res.as_ref().map(|(r, _)| r.live),
        })
    }
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
    cur: Option<Item>,
    /// Title last sent as `stream_now_playing` (the overlay's `♪` line).
    np_sent: String,
    queue: VecDeque<Item>,
    next_id: u64,
    /// Answer owed once the share goes live: (action, entries added).
    reply_live: Option<(&'static str, usize)>,
    sid: String,
    viewers: HashMap<String, Viewer>,
    ff: Option<Ffmpeg>,
    ff_since: Option<Instant>,
    idle_since: Option<Instant>,
    /// Last video frame from ffmpeg (or share start): the no-video auto-stop clock.
    last_video: Instant,
    /// Share start; the RTP clock every item's media is stamped against.
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
        cur: None,
        np_sent: String::new(),
        queue: VecDeque::new(),
        next_id: 1,
        reply_live: None,
        sid: String::new(),
        viewers: HashMap::new(),
        ff: None,
        ff_since: None,
        idle_since: None,
        last_video: Instant::now(),
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
                // ffmpeg closed a pipe: the item ended (or died). Next one.
                if a.ff.is_some() && a.phase == Phase::Live {
                    a.advance().await;
                } else {
                    a.kill_ffmpeg().await;
                }
            }
            Ev::Tick => {}
        }
        // Media keeps the select busy, so timers run whenever they are due,
        // not only when the sleep branch happens to win.
        let now = Instant::now();
        if now >= next {
            for v in a.viewers.values_mut() {
                let _ = v.rtc.handle_input(Input::Timeout(now));
            }
            a.on_tick().await;
        }
        a.sync_now_playing();
    }
}

impl Actor {
    fn emit(&self, action: &'static str, ok: bool, detail: impl Into<String>) {
        let _ = self.event_tx.send(BridgeEvent::ModerationResult { action, ok, detail: detail.into() });
    }

    /// Tell the plugin whenever the current item (or its resolved title)
    /// changes, so the bot description tracks auto-advance too. A string
    /// compare per loop turn; it only emits on change.
    fn sync_now_playing(&mut self) {
        let now = match &self.cur {
            Some(c) if !c.title.is_empty() => c.title.as_str(),
            Some(c) => c.url.as_str(),
            None => "",
        };
        if now != self.np_sent {
            self.np_sent = now.to_string();
            self.emit("stream_now_playing", true, self.np_sent.clone());
        }
    }

    fn emit_json(&self, action: &'static str, v: serde_json::Value) {
        self.emit(action, true, v.to_string());
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

    fn status_json(&self) -> serde_json::Value {
        let played = self.cur.as_ref().map(|c| c.played + self.ff_since.map(|s| s.elapsed()).unwrap_or_default());
        serde_json::json!({
            "active": self.phase != Phase::Idle,
            "state": self.phase.name(),
            "nowPlaying": self.cur.as_ref().map(|c| {
                let mut j = c.json();
                j["playedSecs"] = played.unwrap_or_default().as_secs().into();
                j
            }),
            "queue": self.queue.iter().take(20).enumerate().map(|(i, it)| {
                let mut j = it.json();
                j["position"] = (i + 1).into();
                j
            }).collect::<Vec<_>>(),
            "queueLength": self.queue.len(),
            "viewers": self.viewers.values().filter(|v| v.connected).count(),
            "joining": self.viewers.len(),
            "ffmpeg": self.ff.is_some(),
            "uptimeSecs": self.started.map(|s| s.elapsed().as_secs()).unwrap_or(0),
            "maxHeight": self.cfg.max_height,
            "viewerLimit": self.cfg.viewer_limit,
        })
    }

    fn item(&mut self, e: Entry) -> Item {
        let id = self.next_id;
        self.next_id += 1;
        Item {
            id,
            url: e.url,
            title: e.title,
            res: e.res.map(|r| (r, Instant::now())),
            resolving: false,
            played: Duration::ZERO,
        }
    }

    fn spawn_resolve(&self, id: u64, url: String) {
        let (tx, h) = (self.ctl_tx.clone(), self.cfg.max_height);
        tokio::spawn(async move {
            let _ = tx.send(Ctl::Resolved { id, res: resolve(&url, h).await });
        });
    }

    /// Resolve the next queue entry while the current one plays, so the swap is near-instant.
    fn prefetch(&mut self) {
        if self.phase != Phase::Live {
            return;
        }
        let Some(n) = self.queue.front_mut() else { return };
        if !n.fresh() && !n.resolving {
            n.resolving = true;
            let (id, url) = (n.id, n.url.clone());
            self.spawn_resolve(id, url);
        }
    }

    async fn kill_ffmpeg(&mut self) {
        if let Some(mut f) = self.ff.take() {
            let _ = f.child.start_kill();
            let _ = f.child.wait().await;
            info!("ffmpeg stopped");
        }
        if let (Some(s), Some(c)) = (self.ff_since.take(), self.cur.as_mut()) {
            c.played += s.elapsed();
        }
    }

    /// Tear the whole share down and forget the queue. `notify` also emits the stop event.
    async fn finish(&mut self, notify: bool, why: &str) {
        self.kill_ffmpeg().await;
        if !self.sid.is_empty() {
            self.send("stopstream", &[("id", self.sid.clone())]);
        }
        self.viewers.clear();
        self.sid.clear();
        self.cur = None;
        self.queue.clear();
        self.reply_live = None;
        self.started = None;
        self.idle_since = None;
        let was = self.phase;
        self.set_phase(Phase::Idle);
        if notify && was != Phase::Idle {
            self.emit("stream_stop", true, why);
        }
    }

    /// Make `it` current and bring the share up for it.
    fn begin(&mut self, mut it: Item) {
        if it.fresh() {
            self.cur = Some(it);
            self.setup();
        } else {
            it.resolving = true;
            self.spawn_resolve(it.id, it.url.clone());
            self.cur = Some(it);
            self.set_phase(Phase::Resolving);
        }
    }

    fn setup(&mut self) {
        let name: String = self.cur.as_ref().map(|c| c.label()).unwrap_or_default().chars().take(60).collect();
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

    /// The share failed to come up for the current item: try the next, else give up.
    fn begin_failed(&mut self, why: String) {
        warn!(%why, "stream item failed to start");
        self.cur = None;
        if let Some(next) = self.queue.pop_front() {
            self.begin(next);
            return;
        }
        self.set_phase(Phase::Idle);
        let action = self.reply_live.take().map(|(a, _)| a).unwrap_or("stream_start");
        self.emit(action, false, why);
    }

    /// Swap in the next queue entry under the same share and viewers.
    async fn advance(&mut self) {
        self.kill_ffmpeg().await;
        let Some(mut next) = self.queue.pop_front() else {
            self.finish(true, "the queue finished").await;
            return;
        };
        info!(title = %next.label(), left = self.queue.len(), "stream: next item");
        for v in self.viewers.values_mut() {
            v.wait_idr = true;
        }
        if !next.fresh() && !next.resolving {
            next.resolving = true;
            self.spawn_resolve(next.id, next.url.clone());
        }
        self.cur = Some(next);
        self.idle_since = None;
    }

    fn insert(&mut self, items: Vec<Item>, front: bool) {
        if front {
            for it in items.into_iter().rev() {
                self.queue.push_front(it);
            }
        } else {
            self.queue.extend(items);
        }
        self.queue.truncate(QUEUE_MAX);
    }

    async fn on_add(&mut self, entries: Vec<Entry>, mode: Mode, action: &'static str) {
        if entries.is_empty() {
            self.emit(action, false, "that link had nothing playable in it");
            return;
        }
        let n = entries.len();
        let mut items: Vec<Item> = entries.into_iter().map(|e| self.item(e)).collect();
        let title = items[0].label();
        if self.phase == Phase::Idle {
            if self.own_clid.is_none() {
                self.emit(action, false, "not connected to TeamSpeak");
                return;
            }
            let first = items.remove(0);
            self.insert(items, true);
            self.reply_live = Some((action, n));
            self.begin(first);
            return;
        }
        match mode {
            Mode::Now if self.phase == Phase::Live => {
                self.insert(items, true);
                self.advance().await;
                self.emit_json(action, serde_json::json!({ "playing": title, "added": n, "queueLength": self.queue.len() }));
            }
            Mode::Now | Mode::Next => {
                self.insert(items, true);
                self.emit_json(action, serde_json::json!({ "queued": 1, "title": title, "added": n, "queueLength": self.queue.len() }));
            }
            Mode::Queue => {
                let pos = self.queue.len() + 1;
                self.insert(items, false);
                self.emit_json(action, serde_json::json!({ "queued": pos, "title": title, "added": n, "queueLength": self.queue.len() }));
            }
        }
        self.prefetch();
    }

    /// Check a request off the actor: expand a playlist, or resolve one link
    /// (so a bad link is refused now, not when its turn comes).
    fn request(&self, url: String, title: Option<String>, mode: Mode, playlist: bool) {
        let (tx, h) = (self.ctl_tx.clone(), self.cfg.max_height);
        tokio::spawn(async move {
            let action = "stream_start";
            if playlist || looks_like_playlist(&url) {
                match expand_playlist(&url).await {
                    Ok(entries) if entries.len() > 1 => {
                        let _ = tx.send(Ctl::Add { entries, mode, action });
                        return;
                    }
                    Ok(_) => {}
                    Err(e) => debug!("playlist expand failed ({e}); trying as one video"),
                }
            }
            match resolve(&url, h).await {
                Ok(r) => {
                    let title = title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| r.title.clone());
                    let _ = tx.send(Ctl::Add { entries: vec![Entry { url, title, res: Some(r) }], mode, action });
                }
                Err(e) => {
                    let _ = tx.send(Ctl::Fail { action, detail: format!("could not play that link: {e}") });
                }
            }
        });
    }

    async fn on_ctl(&mut self, c: Ctl) {
        match c {
            Ctl::Connected { own_clid } => self.own_clid = Some(own_clid),
            Ctl::Disconnected => {
                self.own_clid = None;
                self.sid.clear(); // session is gone; nothing to stopstream
                self.finish(true, "connection lost").await;
            }
            Ctl::Status => self.emit_json("stream_status", self.status_json()),
            Ctl::Stop => {
                if self.phase == Phase::Idle {
                    self.emit("stream_stop", true, "nothing was streaming");
                } else {
                    self.finish(true, "stopped").await;
                }
            }
            Ctl::Start { url, title, mode, playlist } => {
                if self.own_clid.is_none() {
                    self.emit("stream_start", false, "not connected to TeamSpeak");
                    return;
                }
                self.request(url, title, mode, playlist);
            }
            Ctl::Add { entries, mode, action } => self.on_add(entries, mode, action).await,
            Ctl::Fail { action, detail } => self.emit(action, false, detail),
            Ctl::Queue(op) => self.on_queue(op).await,
            Ctl::Resolved { id, res } => self.on_resolved(id, res).await,
            Ctl::Raw(name, args) => self.on_raw(name, args).await,
        }
    }

    async fn on_resolved(&mut self, id: u64, res: Result<Resolved, String>) {
        if let Some(c) = self.cur.as_mut().filter(|c| c.id == id) {
            c.resolving = false;
            match res {
                Ok(r) => {
                    if c.title.is_empty() {
                        c.title = r.title.clone();
                    }
                    c.res = Some((r, Instant::now()));
                    if self.phase == Phase::Resolving {
                        self.setup();
                    }
                    // Live: on_tick starts ffmpeg if anyone is watching.
                }
                Err(e) => {
                    let why = format!("could not play {}: {e}", c.label());
                    match self.phase {
                        Phase::Resolving => self.begin_failed(why),
                        Phase::Live => {
                            warn!(%why, "skipping");
                            self.advance().await;
                        }
                        _ => {}
                    }
                }
            }
            return;
        }
        let Some(pos) = self.queue.iter().position(|it| it.id == id) else { return };
        match res {
            Ok(r) => {
                let it = &mut self.queue[pos];
                it.resolving = false;
                if it.title.is_empty() {
                    it.title = r.title.clone();
                }
                it.res = Some((r, Instant::now()));
            }
            Err(e) => {
                if let Some(it) = self.queue.remove(pos) {
                    warn!(title = %it.label(), "dropping unplayable queue entry: {e}");
                }
            }
        }
    }

    fn playlists(&self) -> HashMap<String, SavedList> {
        std::fs::read_to_string(&self.cfg.playlists_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn write_playlists(&self, all: &HashMap<String, SavedList>) -> Result<()> {
        let tmp = format!("{}.tmp", self.cfg.playlists_file);
        std::fs::write(&tmp, serde_json::to_vec_pretty(all)?)?;
        std::fs::rename(&tmp, &self.cfg.playlists_file)?;
        Ok(())
    }

    async fn on_queue(&mut self, q: QueueOp) {
        const A: &str = "stream_queue";
        let idx = |i: Option<u32>, len: usize| i.map(|i| i as usize).filter(|i| *i >= 1 && *i <= len).map(|i| i - 1);
        let key = q.name.as_deref().map(|n| n.trim().to_lowercase()).filter(|n| !n.is_empty());
        match q.op.as_str() {
            "skip" => {
                if self.phase != Phase::Live {
                    self.emit(A, false, if self.phase == Phase::Idle { "nothing is playing" } else { "still starting; try again in a moment" });
                    return;
                }
                let skipped = self.cur.as_ref().map(|c| c.label());
                self.advance().await;
                let now = self.cur.as_ref().map(|c| c.label());
                self.emit_json(A, serde_json::json!({ "skipped": skipped, "nowPlaying": now, "queueLength": self.queue.len() }));
            }
            "clear" => {
                let n = self.queue.len();
                self.queue.clear();
                self.emit_json(A, serde_json::json!({ "cleared": n }));
            }
            "remove" => match idx(q.index, self.queue.len()).and_then(|i| self.queue.remove(i)) {
                Some(it) => self.emit_json(A, serde_json::json!({ "removed": it.label(), "queueLength": self.queue.len() })),
                None => self.emit(A, false, format!("no queue position {}", q.index.unwrap_or(0))),
            },
            "move" => {
                let len = self.queue.len();
                match (idx(q.index, len), idx(q.to, len)) {
                    (Some(f), Some(t)) => {
                        let it = self.queue.remove(f).expect("index checked");
                        let title = it.label();
                        self.queue.insert(t, it);
                        self.emit_json(A, serde_json::json!({ "moved": title, "position": t + 1 }));
                        self.prefetch();
                    }
                    _ => self.emit(A, false, "those queue positions don't exist"),
                }
            }
            "shuffle" => {
                let mut seed = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos() as u64)
                    .unwrap_or(0x9e3779b97f4a7c15)
                    | 1;
                let v = self.queue.make_contiguous();
                for i in (1..v.len()).rev() {
                    seed ^= seed << 13;
                    seed ^= seed >> 7;
                    seed ^= seed << 17;
                    v.swap(i, (seed % (i as u64 + 1)) as usize);
                }
                self.emit_json(A, serde_json::json!({ "shuffled": self.queue.len() }));
                self.prefetch();
            }
            "save" => {
                let Some(key) = key else { return self.emit(A, false, "give the playlist a name") };
                let items: Vec<SavedItem> = self
                    .cur
                    .iter()
                    .chain(self.queue.iter())
                    .map(|it| SavedItem { url: it.url.clone(), title: it.title.clone() })
                    .collect();
                if items.is_empty() {
                    return self.emit(A, false, "nothing is playing or queued to save");
                }
                let mut all = self.playlists();
                let n = items.len();
                all.insert(key.clone(), SavedList { name: q.name.unwrap_or_default().trim().to_string(), items });
                match self.write_playlists(&all) {
                    Ok(()) => self.emit_json(A, serde_json::json!({ "saved": key, "count": n })),
                    Err(e) => self.emit(A, false, format!("couldn't save: {e}")),
                }
            }
            "load" => {
                let Some(key) = key else { return self.emit(A, false, "which playlist?") };
                let Some(list) = self.playlists().remove(&key) else {
                    return self.emit(A, false, format!("no saved playlist called {key}"));
                };
                let entries = list.items.into_iter().map(|s| Entry { url: s.url, title: s.title, res: None }).collect();
                self.on_add(entries, q.mode, A).await;
            }
            "delete" => {
                let Some(key) = key else { return self.emit(A, false, "which playlist?") };
                let mut all = self.playlists();
                if all.remove(&key).is_none() {
                    return self.emit(A, false, format!("no saved playlist called {key}"));
                }
                match self.write_playlists(&all) {
                    Ok(()) => self.emit_json(A, serde_json::json!({ "deleted": key })),
                    Err(e) => self.emit(A, false, format!("couldn't delete: {e}")),
                }
            }
            "playlists" => {
                let mut names: Vec<serde_json::Value> = self
                    .playlists()
                    .values()
                    .map(|l| serde_json::json!({ "name": l.name, "count": l.items.len() }))
                    .collect();
                names.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
                self.emit_json(A, serde_json::json!({ "playlists": names }));
            }
            "list" => self.emit_json(A, self.status_json()),
            other => self.emit(A, false, format!("unknown queue op {other}")),
        }
    }

    async fn on_raw(&mut self, name: String, a: HashMap<String, String>) {
        debug!("<< {} {:?}", name, a.iter().filter(|(k, _)| *k != "offer" && *k != "json").collect::<Vec<_>>());
        match name.as_str() {
            "error" => {
                let msg = a.get("msg").map(|s| s.as_str()).unwrap_or("");
                if self.phase == Phase::AwaitingStart && msg != "ok" {
                    let action = self.reply_live.take().map(|(a, _)| a).unwrap_or("stream_start");
                    self.finish(false, "").await;
                    self.emit(action, false, format!("server refused stream: {msg}"));
                }
            }
            "notifystreamstarted" if self.own_clid.map(|c| c.to_string()) == a.get("clid").cloned() => {
                if self.phase == Phase::AwaitingStart {
                    self.sid = a.get("id").cloned().unwrap_or_default();
                    self.started = Some(Instant::now());
                    self.last_video = Instant::now();
                    self.set_phase(Phase::Live);
                    info!(sid = %self.sid, title = %self.cur.as_ref().map(|c| c.label()).unwrap_or_default(), "stream live");
                    let (action, added) = self.reply_live.take().unwrap_or(("stream_start", 1));
                    let mut j = self.status_json();
                    j["added"] = added.into();
                    self.emit_json(action, j);
                    self.prefetch();
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
        let Some(t0) = self.started else { return };
        self.last_video = Instant::now();
        let idr = is_idr(&au);
        let now = Instant::now();
        let ts = (now.duration_since(t0).as_micros() as u64) * 9 / 100; // 90 kHz
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
        let ts = f.audio_offset + rtp_ts.wrapping_sub(base) as u64;
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
            // Two yt-dlp tries plus a codec probe.
            Phase::Resolving if self.phase_since.elapsed() > RESOLVE_TIMEOUT * 2 + Duration::from_secs(20) => {
                self.begin_failed("resolve timed out".into());
            }
            Phase::AwaitingStart if self.phase_since.elapsed() > SETUP_TIMEOUT => {
                let action = self.reply_live.take().map(|(a, _)| a).unwrap_or("stream_start");
                self.finish(false, "").await;
                self.emit(action, false, "server never confirmed the stream");
            }
            // Nobody watching, or the source stalled: don't leave a dead share up.
            Phase::Live if self.last_video.elapsed() > self.cfg.no_video_stop => {
                info!(secs = self.cfg.no_video_stop.as_secs(), "no video; ending the share");
                let why = format!("no video for {} minutes", self.cfg.no_video_stop.as_secs().div_ceil(60));
                self.finish(true, &why).await;
            }
            Phase::Live => {
                // Lazy start: ffmpeg only runs while someone is (about to be) watching.
                if !self.viewers.is_empty() {
                    self.idle_since = None;
                    if self.ff.is_none() {
                        self.start_current().await;
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

    /// Run ffmpeg for the current item, re-resolving first if its URLs went stale.
    async fn start_current(&mut self) {
        let Some(t0) = self.started else { return };
        let Some(c) = self.cur.as_mut() else { return };
        if !c.fresh() {
            if !c.resolving {
                c.resolving = true;
                let (id, url) = (c.id, c.url.clone());
                self.spawn_resolve(id, url);
            }
            return;
        }
        let (r, _) = c.res.as_ref().expect("fresh implies resolved");
        // A VOD picks up where it was (minus a little context); live has no position.
        let seek = (!r.live && c.played > Duration::from_secs(5)).then(|| c.played - Duration::from_secs(2));
        let offset = (t0.elapsed().as_micros() as u64) * 48 / 1000;
        match start_ffmpeg(r, seek, self.cfg.max_height, offset).await {
            Ok(f) => {
                info!(title = %c.label(), copy = r.copy, seek = ?seek, "ffmpeg started");
                if let Some(s) = seek {
                    c.played = s;
                }
                self.ff = Some(f);
                self.ff_since = Some(Instant::now());
                self.last_video = Instant::now(); // a fresh viewer gets a full window for the first frame
                for v in self.viewers.values_mut() {
                    v.wait_idr = true;
                }
                self.prefetch();
            }
            Err(e) => {
                warn!("ffmpeg start failed: {e}");
                self.advance().await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_parses_with_queue_default() {
        assert_eq!(Mode::parse(None), Mode::Queue);
        assert_eq!(Mode::parse(Some("NOW")), Mode::Now);
        assert_eq!(Mode::parse(Some("next")), Mode::Next);
        assert_eq!(Mode::parse(Some("whatever")), Mode::Queue);
    }

    #[test]
    fn playlist_links_are_recognised() {
        assert!(looks_like_playlist("https://www.youtube.com/playlist?list=PL123"));
        assert!(looks_like_playlist("https://vimeo.com/showcase/123"));
        assert!(looks_like_playlist("https://www.twitch.tv/pgl/videos?filter=archives"));
        assert!(!looks_like_playlist("https://www.youtube.com/watch?v=abc&list=PL123"));
        assert!(!looks_like_playlist("https://rumble.com/v4abc-some-video.html"));
        assert!(!looks_like_playlist("https://kick.com/somechannel"));
    }

    #[test]
    fn stale_items_need_a_fresh_resolve() {
        let r = Resolved { title: "t".into(), urls: vec!["http://x".into()], copy: true, live: true };
        let mut it = Item { id: 1, url: "u".into(), title: String::new(), res: None, resolving: false, played: Duration::ZERO };
        assert!(!it.fresh());
        it.res = Some((r.clone(), Instant::now()));
        assert!(it.fresh());
        it.res = Some((r, Instant::now() - TTL_LIVE - Duration::from_secs(1)));
        assert!(!it.fresh());
        assert_eq!(it.label(), "u");
    }

    #[test]
    fn vimeo_pages_retry_through_the_player() {
        assert_eq!(alt_url("https://vimeo.com/76979871"), "https://player.vimeo.com/video/76979871");
        assert_eq!(alt_url("https://player.vimeo.com/video/1"), "https://player.vimeo.com/video/1");
        assert_eq!(alt_url("https://vimeo.com/showcase/9"), "https://vimeo.com/showcase/9");
        assert_eq!(alt_url("https://rumble.com/v1-x.html"), "https://rumble.com/v1-x.html");
    }
}
