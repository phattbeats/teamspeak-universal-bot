//! The Sexton — persistent TeamSpeak channel chat logger (PHA-3099 / PHA-3173),
//! and — as of PHA-3342 — the audio/voice bridge too.
//!
//! Behaviour (see PHA-3099 for the full spec):
//! 1. Rolling log of the last messages in the channel description (newest at the
//!    bottom, byte budget under the server's 8192-byte hard cap).
//! 2. Catch-up PM to any client that joins/hops into the watched channel
//!    (rate-limited per client), preceded — once per client, ever — by the
//!    welcome PM that says out loud what the Sexton does (PHA-3305).
//! 3. Full markdown log on disk, one file per channel per day.
//!
//! HARD RULE: only real user-authored text messages sent to the watched channel
//! are logged or displayed. Joins, leaves, moves, mutes, aways, kicks, bans,
//! pokes, channel edits, server messages and the bot's own messages are never
//! logged and never touch the description.
//!
//! ## PHA-3342: one container, one bot account
//!
//! Brandon flagged two bot slots in the channel roster (`Sexton` for text,
//! `Sexton-Bridge` for audio) and asked for "everything running off of one
//! docker container / one bot account". PHA-3341 already collapsed the two
//! `tsclientlib::Connection`s into one, fronted by a Unix-socket IPC
//! (`bridge-proto`) to a still-separate `ts-bridge` container. This change
//! removes that second container: the audio sidecar's mixer, Opus codec,
//! and public WebSocket server (formerly `ts-bridge/src/{mixer,protocol,
//! ws_server,ts_client}.rs`) now run inside this binary, driven by the same
//! `Connection` and the same `con.events()` stream the text lane already
//! owned — see `audio.rs` for the ported per-tick logic and `mod audio`'s
//! doc comment for the fuller history.
//!
//! `bridge-proto`'s `BridgeEvent`/`BridgeCommand`/`Snapshot` types are
//! reused here as the in-process vocabulary between this file's event loop
//! and `ws_server`'s WebSocket clients (a `tokio::sync::broadcast` /
//! `mpsc` pair, not the Unix socket bridge-proto also defines — see the PR
//! description for why a self-dial loopback socket inside one process
//! wasn't worth adding).

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use clap::Parser;
use chrono::Local;
use futures::prelude::*;
use md5::{Digest, Md5};
use tokio::sync::{broadcast, mpsc, Mutex as TokioMutex};
use tracing::{error, info, warn};

use tsclientlib::prelude::*;
use tsclientlib::messages::c2s::{
    OutChannelListRequestMessage, OutClientMoveMessage, OutClientMovePart,
};
use tsclientlib::{
    events::{Event, PropertyId},
    ChannelId, ClientId, Connection, Identity, MessageHandle, MessageTarget, StreamItem,
};

mod audio;
mod mixer;
mod protocol;
mod ws_server;

use audio::AudioState;
use mixer::Mixer;

/// Channel description hard cap is 8192 bytes (`TS3_MAX_SIZE_CHANNEL_DESCRIPTION`).
/// Stay well under it — PHA-3173 asks for ~7500.
const DESC_BUDGET_BYTES: usize = 7500;
/// The notice as Brandon picked it on PHA-3177 (draft B, plainspoken caretaker),
/// stage 1. 124 bytes, so it costs nothing worth counting out of the budget.
///
/// STAGE 2 — the voice clause, `Say "Sexton" out loud and he answers.` — ships
/// the day PHA-3228 lands and not one commit earlier. It is a promise, and it is
/// false until the stt-tts lane actually runs. Same rule for `WELCOME_PM`.
const DESC_HEADER: &str = "— the Sexton keeps this hall: the last lines stay here, \
                           the whole log is kept below. Ask him and he'll fetch the rest. —\n";
/// First-contact PM: sent once per client, ever, immediately before their first
/// catch-up (PHA-3305). Not the catch-up PM — see `catchup_text`.
///
/// Stage 2 adds the voice paragraph and the "your voice doesn't leave the house"
/// line. Do not add either early: the second one is the $0-ceiling constraint
/// from PHA-3228 restated as a wording rule, and a hosted metered STT anywhere
/// in the path would make it a lie.
const WELCOME_PM: &str = "Evening. I'm the Sexton — I keep the records for this hall.\n\n\
                          One thing worth knowing before you settle in: everything typed in \
                          the channel goes into the log, and the last twenty lines sit in the \
                          channel description where you can see them.\n\n\
                          Ask me for something out of the log and I'll go down and find it.";
/// How many messages the catch-up PM includes.
const CATCHUP_PM_COUNT: usize = 15;
/// One catch-up PM per client per this long.
const PM_RATE_LIMIT: Duration = Duration::from_secs(10 * 60);
/// Where the welcomed-client list lives, inside the channel's log directory.
const WELCOMED_FILE: &str = ".welcomed";
/// How many messages we keep in memory (comfortably covers the description
/// budget and the catch-up PM window).
const HISTORY_CAP: usize = 200;
/// Reconnect backoff: start here, multiply by this factor on every failure,
/// cap at the max. Polite — avoids re-tripping the server's antiflood ban.
const BACKOFF_INITIAL: Duration = Duration::from_secs(60);
const BACKOFF_FACTOR: u32 = 4;
const BACKOFF_MAX: Duration = Duration::from_secs(3600);
/// How long to wait for the server to answer our `channellist` request before
/// giving up on resolving the watched channel.
const CHANNEL_TREE_TIMEOUT: Duration = Duration::from_secs(15);
/// No catch-up PMs for this long after connecting. The server streams the
/// existing client list to us as a burst of "client added" events just after
/// the channel list, and those clients did not join anything — our own
/// connect is not their arrival. Without this a bot restart PMs the whole
/// room.
const STARTUP_GRACE: Duration = Duration::from_secs(5);
/// How long to keep retrying `clientupdate client_nickname=<configured>`
/// after the server assigns us a suffixed nickname at connect time (PHA-3426).
/// A stale identity's session is reaped by the server on its own schedule
/// (observed up to several minutes — see the ts-bridge deploy traps note);
/// this window is generous so a normal restart self-heals without a human
/// re-restarting the container.
const NICKNAME_RECLAIM_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const NICKNAME_RECLAIM_RETRY_INTERVAL: Duration = Duration::from_secs(20);
/// How long to wait, right after connecting, for our own `Client` book entry
/// to appear before giving up on reading back the assigned nickname.
const OWN_CLIENT_ENTRY_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Parser, Debug, Clone)]
#[command(name = "sexton", about = "The Sexton — persistent TeamSpeak channel chat logger")]
struct Args {
    /// Server address. Default is the in-cluster Docker network name for the
    /// TS6 container (phattvip network) — connect by container name, not the
    /// public hostname (RAID and the server share one public IP, so routing
    /// through it gets flood-scored as if from the public internet).
    #[arg(short = 'a', long, default_value = "teamspeak6-server")]
    address: String,

    /// Server port.
    #[arg(short = 'p', long, default_value_t = 9987)]
    port: u16,

    /// If set, ignore `--address` and connect to the public fallback
    /// (`teamspeak.phatt.vip`) instead. For running the bot somewhere that
    /// isn't on the TS6 container's Docker network.
    #[arg(long, default_value_t = false)]
    public_fallback: bool,

    /// Bot nickname.
    #[arg(short = 'n', long, default_value = "Sexton")]
    nickname: String,

    /// Channel name to sit in (case-sensitive). Resolved from the tree at startup.
    #[arg(short = 'c', long)]
    channel: String,

    /// Optional channel password.
    #[arg(short = 'w', long, default_value = "")]
    channel_password: String,

    /// Bot identity (TS3 identity string, "counter V base64"). If empty, a new
    /// one is generated and printed once at startup — pin it in Paperclip
    /// secrets so the UID stays stable across restarts.
    #[arg(short = 'i', long, default_value = "")]
    identity: String,

    /// Base directory for on-disk logs. Created if missing.
    #[arg(short = 'l', long, default_value = "/mnt/user/appdata/sexton")]
    log_dir: PathBuf,

    /// Optional path to a PNG/RGBA avatar to upload on connect. If absent, no
    /// avatar is set (the server falls back to the bot's identity hash).
    #[arg(short = 'A', long, default_value = "")]
    avatar_path: String,

    /// Optional script to run once, after the first successful connect (used
    /// to post a status comment back to Paperclip). Failures are logged and
    /// otherwise ignored.
    #[arg(long, default_value = "")]
    on_connected: String,

    /// PHA-3342: bind address for the audio/voice bridge's WebSocket server
    /// (`PROTOCOL.md`) — the realtime voice runtime and `bridge-test` are
    /// its only consumers. Formerly `ts-bridge`'s `WS_BIND` env var, now a
    /// flag on the one binary that owns both lanes. Never expose this
    /// outside the compose network.
    #[arg(long, default_value = "0.0.0.0:9099")]
    ws_bind: String,

    /// PHA-3342: duck-envelope floor (0..1) applied to the music lane
    /// while the voice lane has queued samples or any human is talking.
    /// Formerly `ts-bridge`'s `DUCK_GAIN` env var. Spec: reach the floor
    /// within 50 ms, recover to full gain within 800 ms (see `mixer.rs`).
    #[arg(long, default_value_t = 0.25)]
    duck_gain: f32,

    /// PHA-3342: optional webhook URL for the `say_text` fallback TTS hook
    /// (PHA-3228). Formerly `ts-bridge`'s `TTS_WEBHOOK_URL` env var. Not
    /// wired up yet — a `say_text` frame is logged and otherwise ignored
    /// either way; push `voice_audio` directly in the meantime.
    #[arg(long, default_value = "")]
    tts_webhook_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LoggedMessage {
    time_label: String, // HH:MM, local time
    nickname: String,
    text: String,
}

impl LoggedMessage {
    /// The one rendering of a message. The description, the catch-up PM and
    /// the on-disk log all go through this, so `parse_log_line` can read the
    /// log back without a second serialisation format (PHA-3217).
    fn render_line(&self) -> String {
        format!("{}  {}: {}\n", self.time_label, self.nickname, self.text)
    }
}

/// Parse one rendered log line — `HH:MM  nickname: message` — back into a
/// `LoggedMessage`. Returns `None` for anything not in that exact shape (blank
/// lines, hand-added markdown, a nickname containing a colon): the caller skips
/// those rather than failing.
fn parse_log_line(line: &str) -> Option<LoggedMessage> {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let (time_label, rest) = line.split_once("  ")?;
    let b = time_label.as_bytes();
    if b.len() != 5
        || !b[0].is_ascii_digit()
        || !b[1].is_ascii_digit()
        || b[2] != b':'
        || !b[3].is_ascii_digit()
        || !b[4].is_ascii_digit()
    {
        return None;
    }
    // Split on the first colon, so the nickname can never contain one — same
    // as the `([^:]+): (.*)` the renderer produces.
    let (nickname, text) = rest.split_once(':')?;
    if nickname.is_empty() {
        return None;
    }
    Some(LoggedMessage {
        time_label: time_label.to_string(),
        nickname: nickname.to_string(),
        text: text.strip_prefix(' ').unwrap_or(text).to_string(),
    })
}

struct ChannelState {
    channel_id: ChannelId,
    channel_name: String,
    history: VecDeque<LoggedMessage>,
    last_pm: HashMap<ClientId, tokio::time::Instant>,
    /// Clients that have already had the one-time welcome PM, keyed by
    /// TeamSpeak uid (stable across reconnects and restarts) and persisted to
    /// disk. Deliberately *not* the `last_pm` map: that one expires every ten
    /// minutes, and the welcome goes out once and stays out.
    welcomed: HashSet<String>,
    log_dir: PathBuf,
    /// Clients that were already connected when the bot came up — never PM'd
    /// on account of our own connect.
    preexisting: HashSet<ClientId>,
    /// Catch-up PMs are suppressed until this instant (see STARTUP_GRACE).
    quiet_until: tokio::time::Instant,
    /// Commands we have sent and not yet seen the server's verdict on, keyed
    /// by return code. `send()` only queues a command — it says nothing about
    /// whether the server accepted it — so every command that matters is sent
    /// with a return code and reconciled here.
    pending_cmds: HashMap<u16, String>,
}

impl ChannelState {
    fn new(
        channel_id: ChannelId,
        channel_name: String,
        log_dir: PathBuf,
        preexisting: HashSet<ClientId>,
    ) -> Self {
        Self {
            channel_id,
            channel_name,
            history: VecDeque::with_capacity(HISTORY_CAP),
            last_pm: HashMap::new(),
            welcomed: HashSet::new(),
            log_dir,
            preexisting,
            quiet_until: tokio::time::Instant::now() + STARTUP_GRACE,
            pending_cmds: HashMap::new(),
        }
    }

    fn push(&mut self, nickname: String, raw_message: &str) -> LoggedMessage {
        let text = strip_bbcode(raw_message);
        let time_label = Local::now().format("%H:%M").to_string();
        let entry = LoggedMessage { time_label, nickname, text };
        self.history.push_back(entry.clone());
        while self.history.len() > HISTORY_CAP {
            self.history.pop_front();
        }
        entry
    }

    /// Seed the in-memory ring from the on-disk log so a restart does not blank
    /// the channel description (PHA-3217). The ring is memory-only, so without
    /// this the initial `channeledit` writes a bare header over a channel the
    /// markdown log still has the day's messages for.
    ///
    /// Yesterday's file is read first, so a restart early in the day still
    /// shows something; the newest lines that fit `DESC_BUDGET_BYTES` win, so
    /// once today's log is long enough yesterday's drops out on its own.
    ///
    /// Fail-open by contract: a missing, unreadable or malformed log leaves the
    /// history as it is and must never stop the bot connecting.
    fn seed_history_from_disk(&mut self) {
        let dir = self.log_dir.join(&self.channel_name);
        let today = Local::now().date_naive();
        let yesterday = today.pred_opt().unwrap_or(today);

        let mut parsed: Vec<LoggedMessage> = Vec::new();
        let mut skipped = 0usize;
        for day in [yesterday, today] {
            let path = dir.join(format!("{}.md", day.format("%Y-%m-%d")));
            let body = match std::fs::read_to_string(&path) {
                Ok(body) => body,
                Err(e) => {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        warn!(error = %e, path = %path.display(), "reading log back for the description failed");
                    }
                    continue;
                }
            };
            for line in body.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                match parse_log_line(line) {
                    Some(entry) => parsed.push(entry),
                    None => skipped += 1,
                }
            }
        }

        // Keep the newest lines that fit the budget the description uses, so
        // what we seed is exactly what the first `channeledit` can show.
        let mut total = DESC_HEADER.len();
        let mut keep = 0usize;
        for entry in parsed.iter().rev() {
            let line_len = entry.render_line().len();
            if keep >= HISTORY_CAP || total + line_len > DESC_BUDGET_BYTES {
                break;
            }
            total += line_len;
            keep += 1;
        }
        let start = parsed.len() - keep;
        for entry in parsed.drain(start..) {
            self.history.push_back(entry);
        }
        if keep > 0 || skipped > 0 {
            info!(seeded = keep, skipped, dir = %dir.display(), "rehydrated description history from disk");
        }
    }

    /// Render the rolling description: header + newest-at-bottom lines that
    /// fit within DESC_BUDGET_BYTES.
    fn render_description(&self) -> String {
        let mut lines: Vec<String> = Vec::new();
        let mut total = DESC_HEADER.len();
        for entry in self.history.iter().rev() {
            let line = entry.render_line();
            if total + line.len() > DESC_BUDGET_BYTES {
                break;
            }
            total += line.len();
            lines.push(line);
        }
        lines.reverse();
        let mut out = String::with_capacity(total);
        out.push_str(DESC_HEADER);
        for line in lines {
            out.push_str(&line);
        }
        out
    }

    fn welcomed_path(&self) -> PathBuf {
        self.log_dir.join(&self.channel_name).join(WELCOMED_FILE)
    }

    /// Read back who has already been welcomed (PHA-3305). Without this every
    /// container restart re-introduces the Sexton to everyone who walks in, and
    /// "once" quietly becomes "once per deploy".
    ///
    /// Fail-open by contract, like `seed_history_from_disk`: a missing or
    /// unreadable list costs one repeated welcome, never a failed connect.
    fn load_welcomed_from_disk(&mut self) {
        let path = self.welcomed_path();
        match std::fs::read_to_string(&path) {
            Ok(body) => {
                for line in body.lines() {
                    let key = line.trim();
                    if !key.is_empty() {
                        self.welcomed.insert(key.to_string());
                    }
                }
                info!(
                    known = self.welcomed.len(),
                    path = %path.display(),
                    "loaded the already-welcomed list"
                );
            }
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    warn!(
                        error = %e,
                        path = %path.display(),
                        "reading the already-welcomed list failed; someone may be welcomed twice"
                    );
                }
            }
        }
    }

    /// Record `key` as welcomed. `durable` keys — client uids — are appended to
    /// the on-disk list; the session-only fallback key is not, because a runtime
    /// `ClientId` means nothing to the next process.
    fn remember_welcomed(&mut self, key: String, durable: bool) {
        if durable {
            if let Err(e) = self.append_welcomed(&key) {
                warn!(error = %e, "recording the welcome on disk failed; it may go out again after a restart");
            }
        }
        self.welcomed.insert(key);
    }

    fn append_welcomed(&self, key: &str) -> Result<()> {
        let dir = self.log_dir.join(&self.channel_name);
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("creating log dir {}", dir.display()))?;
        let path = dir.join(WELCOMED_FILE);
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("opening welcomed list {}", path.display()))?;
        writeln!(f, "{key}")?;
        Ok(())
    }

    fn catchup_text(&self) -> String {
        if self.history.is_empty() {
            return format!("Nothing logged yet in \"{}\".", self.channel_name);
        }
        let start = self.history.len().saturating_sub(CATCHUP_PM_COUNT);
        let mut out = String::new();
        for entry in self.history.iter().skip(start) {
            out.push_str(&entry.render_line());
        }
        out
    }

    fn append_disk_log(&self, entry: &LoggedMessage) -> Result<()> {
        let dir = self.log_dir.join(&self.channel_name);
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("creating log dir {}", dir.display()))?;
        let today = Local::now().format("%Y-%m-%d").to_string();
        let path = dir.join(format!("{today}.md"));
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("opening log file {}", path.display()))?;
        write!(f, "{}", entry.render_line())?;
        Ok(())
    }
}

/// Strip BBCode tags, keeping the visible text. `[url=X]text[/url]` -> `text`,
/// bare `[url]X[/url]` -> `X`. Other tags (`[b]`, `[i]`, `[color=..]`, etc.)
/// are dropped, keeping their inner text.
fn strip_bbcode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            if let Some(close) = input[i..].find(']') {
                let tag = &input[i + 1..i + close];
                let tag_lower = tag.to_ascii_lowercase();
                if tag_lower.starts_with("url") {
                    // Find the matching [/url] to extract the inner text.
                    if let Some(end_tag) = input[i + close + 1..].to_ascii_lowercase().find("[/url]") {
                        let inner = &input[i + close + 1..i + close + 1 + end_tag];
                        out.push_str(inner.trim());
                        i = i + close + 1 + end_tag + "[/url]".len();
                        continue;
                    }
                }
                // Any other tag (opening or closing): drop it.
                i += close + 1;
                continue;
            }
        }
        // Copy one char at a time (safe for UTF-8 boundaries).
        let ch_len = input[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        out.push_str(&input[i..i + ch_len]);
        i += ch_len;
    }
    out
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let args = Args::parse();
    std::fs::create_dir_all(&args.log_dir)
        .with_context(|| format!("creating log dir {}", args.log_dir.display()))?;

    let address = if args.public_fallback {
        "teamspeak.phatt.vip".to_string()
    } else {
        args.address.clone()
    };

    info!(address = %address, port = args.port, channel = %args.channel, log_dir = %args.log_dir.display(), "sexton starting");

    let ws_bind: SocketAddr = args
        .ws_bind
        .parse()
        .with_context(|| format!("parsing --ws-bind {:?}", args.ws_bind))?;
    let tts_webhook_url = if args.tts_webhook_url.is_empty() {
        None
    } else {
        Some(args.tts_webhook_url.clone())
    };

    // PHA-3342: the Mixer, the bridge event/command channels, and the WS
    // snapshot all outlive every TS reconnect attempt — same lesson
    // ts-bridge's PHA-3216 taught (a mixer tied to the connection attempt
    // loses its queued audio and its duck envelope on every reconnect).
    // `run_once` gets them by reference/clone on each attempt and rebuilds
    // only the per-connection `AudioState` (opus encoders, jitter buffers)
    // that a stale TS session can't meaningfully resume anyway.
    let mixer = Arc::new(TokioMutex::new(Mixer::new(args.duck_gain)));
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<bridge_proto::BridgeCommand>();
    let (event_tx, _) = broadcast::channel::<bridge_proto::BridgeEvent>(256);
    let snapshot = Arc::new(TokioMutex::new(bridge_proto::Snapshot::default()));

    {
        let mixer = mixer.clone();
        let cmd_tx = cmd_tx.clone();
        let event_tx = event_tx.clone();
        let snapshot = snapshot.clone();
        let tts_webhook_url = tts_webhook_url.clone();
        tokio::spawn(async move {
            if let Err(e) = ws_server::run(ws_bind, mixer, cmd_tx, event_tx, tts_webhook_url, snapshot).await {
                error!(error = %e, "audio bridge websocket server exited");
            }
        });
    }

    let mut backoff = BACKOFF_INITIAL;
    let mut first_connect = true;
    loop {
        match run_once(
            &args,
            &address,
            first_connect,
            &mixer,
            &mut cmd_rx,
            &event_tx,
            &snapshot,
        )
        .await
        {
            Ok(()) => {
                // Clean disconnect (shouldn't normally happen) — reset backoff.
                backoff = BACKOFF_INITIAL;
            }
            Err(e) => {
                error!(error = %e, next_retry_in_secs = backoff.as_secs(), "connection died; will retry after backoff");
                first_connect = false;
                tokio::time::sleep(backoff).await;
                backoff = std::cmp::min(backoff * BACKOFF_FACTOR, BACKOFF_MAX);
                continue;
            }
        }
        tokio::time::sleep(backoff).await;
    }
}

async fn run_once(
    args: &Args,
    address: &str,
    first_connect: bool,
    mixer: &Arc<TokioMutex<Mixer>>,
    cmd_rx: &mut mpsc::UnboundedReceiver<bridge_proto::BridgeCommand>,
    event_tx: &broadcast::Sender<bridge_proto::BridgeEvent>,
    snapshot: &Arc<TokioMutex<bridge_proto::Snapshot>>,
) -> Result<()> {
    let identity = if args.identity.is_empty() {
        let id = Identity::create();
        warn!("no identity supplied; generated a new one — pin this in Paperclip secrets");
        id
    } else {
        Identity::new_from_str(&args.identity)
            .map_err(|e| anyhow!("parsing identity: {e:?}"))?
    };

    let addr = format!("{address}:{}", args.port);
    let mut con = Connection::build(addr)
        .identity(identity)
        .name(args.nickname.clone())
        .connect()
        .map_err(|e| anyhow!("connect: {e}"))?;

    // Wait for the first BookEvents batch — the server has accepted us and
    // sent the initial channel tree / client list.
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

    // TS6 patch (PHA-3099 finding #6): unlike TS3, tsclientlib's handshake
    // against TS6 does not push the channel list or subscribe to all channels
    // unprompted — both must be requested explicitly, or the channel tree
    // stays empty and no text/move events arrive outside our own channel.
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
    // Wait for the `channellist` answer, pumping the event stream while we do.
    // tsclientlib only advances the connection — and applies book updates —
    // while its event stream is polled, so a bare sleep here leaves
    // `state.channels` empty and the channel unresolvable no matter how long
    // we wait.
    let deadline = tokio::time::Instant::now() + CHANNEL_TREE_TIMEOUT;
    let (own_client_id, channel_id) = loop {
        {
            let state = con.get_state().map_err(|e| anyhow!("get_state: {e}"))?;
            if let Some((id, _)) = state.channels.iter().find(|(_, ch)| ch.name == args.channel) {
                break (state.own_client, *id);
            }
        }
        match tokio::time::timeout_at(deadline, con.events().next()).await {
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(anyhow!("waiting for channel list: {e}")),
            Ok(None) => return Err(anyhow!("stream ended while waiting for channel list")),
            Err(_) => {
                return Err(anyhow!(
                    "channel {:?} not found in channel tree after {}s",
                    args.channel,
                    CHANNEL_TREE_TIMEOUT.as_secs()
                ))
            }
        }
    };

    // Everyone already on the server when we came up. They did not join
    // anything — our own connect is not their arrival — so they must not be
    // PM'd by the catch-up path.
    let preexisting: HashSet<ClientId> = con
        .get_state()
        .map_err(|e| anyhow!("get_state: {e}"))?
        .clients
        .keys()
        .copied()
        .collect();

    info!(?channel_id, own = ?own_client_id, clients_present = preexisting.len(), "connected; channel resolved");

    // PHA-3426: the server accepts a login whose requested nickname is still
    // held by a not-yet-reaped ghost session, but silently suffixes it
    // ("Sexton" -> "Sexton1") instead of refusing the connection — see the
    // ts-bridge deploy traps note on reused TS_IDENTITY. Detect that here and
    // reclaim the configured name once the collision clears, rather than
    // requiring a human to notice and restart the container.
    //
    // Our own `Client` book entry can land a moment after the channel tree
    // does (the ClientEnterView burst for everyone already in the channel,
    // including us, is still in flight right after "connected" above), so
    // poll briefly for it instead of reading immediately — reading too early
    // would see no entry and misfire on every clean connect, not just a
    // colliding one.
    let own_name_deadline = tokio::time::Instant::now() + OWN_CLIENT_ENTRY_TIMEOUT;
    let assigned_name = loop {
        if let Some(name) = con
            .get_state()
            .map_err(|e| anyhow!("get_state: {e}"))?
            .clients
            .get(&own_client_id)
            .map(|c| c.name.clone())
        {
            break name;
        }
        match tokio::time::timeout_at(own_name_deadline, con.events().next()).await {
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => return Err(anyhow!("waiting for own client entry: {e}")),
            Ok(None) => return Err(anyhow!("stream ended while waiting for own client entry")),
            Err(_) => {
                return Err(anyhow!(
                    "own client entry did not appear within {}s",
                    OWN_CLIENT_ENTRY_TIMEOUT.as_secs()
                ))
            }
        }
    };
    if assigned_name != args.nickname {
        warn!(
            assigned = %assigned_name,
            configured = %args.nickname,
            "server assigned a different nickname than configured; retrying rename"
        );
        reclaim_nickname(&mut con, &args.nickname).await?;
    }

    // Move into the watched channel.
    let password = if args.channel_password.is_empty() {
        None
    } else {
        Some(args.channel_password.clone().into())
    };
    OutClientMoveMessage::new(&mut std::iter::once(OutClientMovePart {
        client_id: own_client_id,
        channel_id,
        channel_password: password,
    }))
    .send(&mut con)
    .map_err(|e| anyhow!("joining channel: {e}"))?;

    let mut state =
        ChannelState::new(channel_id, args.channel.clone(), args.log_dir.clone(), preexisting);

    // Rehydrate the ring from disk before the initial `channeledit` below —
    // otherwise a restart overwrites a populated description with a bare
    // header (PHA-3217).
    state.seed_history_from_disk();
    // And who has already been introduced to the Sexton, so a restart does not
    // re-welcome the room (PHA-3305).
    state.load_welcomed_from_disk();

    // Kick off the avatar upload (if configured). We track the handle and
    // finish the two-step process (upload, then set_avatar_hash) once the
    // FileUpload result arrives on the event stream.
    let mut pending_avatar: Option<(tsclientlib::FiletransferHandle, Vec<u8>)> = None;
    if !args.avatar_path.is_empty() {
        match std::fs::read(&args.avatar_path) {
            Ok(bytes) => {
                info!(path = %args.avatar_path, size = bytes.len(), "avatar upload starting");
                match con.upload_file(ChannelId(0), "/avatar", None, bytes.len() as u64, true, false) {
                    Ok(handle) => pending_avatar = Some((handle, bytes)),
                    Err(e) => error!(error = %e, "avatar upload request failed"),
                }
            }
            Err(e) => error!(error = %e, path = %args.avatar_path, "reading avatar file failed"),
        }
    }

    if first_connect || true {
        // Always push an initial (possibly empty) description on connect so
        // the channel reflects the Sexton's format immediately.
        match set_description(&mut con, channel_id, &state.render_description()) {
            Ok(handle) => {
                state.pending_cmds.insert(handle.0, "initial channeledit description".to_string());
            }
            Err(e) => warn!(error = %e, "initial description push failed"),
        }
    }

    if !args.on_connected.is_empty() {
        run_on_connected_hook(&args.on_connected);
    }

    // PHA-3342: the audio lane's per-connection state (opus encoders,
    // per-speaker jitter buffers) — fresh every `run_once` attempt, same as
    // `state` above. See `audio.rs` for why this can't meaningfully survive
    // a reconnect.
    let mut audio_state = AudioState::new()?;
    let mut last_roster_sig: Option<u64> = None;
    let mut last_channel_id: Option<u64> = None;
    audio::emit_state_and_roster(&mut con, event_tx, snapshot, &mut last_roster_sig, &mut last_channel_id).await;

    let mut tick = tokio::time::interval(Duration::from_millis(20));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // The text lane used to just `.await` `con.events().next()` in a bare
    // loop. PHA-3342 adds two more wakeups against the same connection: the
    // 20 ms audio tick and inbound `BridgeCommand`s from the WS bridge
    // clients. `Connection::events()` hands out a stream that mutably
    // borrows `con` for as long as it lives, and `select!` keeps every
    // branch's future alive for the whole statement — so the select only
    // *waits*: it pulls the owned wakeup out, drops the event stream, and
    // the handlers below get `con` back to themselves (same pattern the old
    // `ts_client.rs` used for its own three-way select).
    enum Wake {
        Cmd(Option<bridge_proto::BridgeCommand>),
        Tick,
        Event(Option<std::result::Result<StreamItem, tsclientlib::Error>>),
    }

    loop {
        let wake = {
            let mut events = con.events();
            tokio::select! {
                biased;
                cmd = cmd_rx.recv() => Wake::Cmd(cmd),
                _ = tick.tick() => Wake::Tick,
                ev = events.next() => Wake::Event(ev),
            }
        };

        match wake {
            Wake::Cmd(cmd) => {
                if let Some(cmd) = cmd {
                    handle_bridge_command(&mut con, own_client_id, mixer, &mut audio_state, cmd).await;
                }
                // `None` means every `cmd_tx` clone (the WS server's) is
                // gone, which only happens if the WS server task itself
                // panicked — not fatal to the TS connection, so keep going.
            }
            Wake::Tick => {
                audio_state.on_tick(&mut con, mixer, event_tx).await;
            }
            Wake::Event(ev) => match ev {
                Some(Ok(StreamItem::Audio(audio_pkt))) => {
                    audio_state.on_audio_packet(mixer, event_tx, audio_pkt).await;
                }
                Some(Ok(StreamItem::BookEvents(events))) => {
                    // PHA-3342: forward text messages to bridge subscribers
                    // exactly as the old ts_client.rs did, before the
                    // existing text-lane handler below (which logs/PMs the
                    // same events) runs. Two passes over the same `&events`
                    // slice rather than draining it once, since
                    // `handle_event` still wants to consume `Event` by
                    // value and `Event` isn't `Copy`.
                    for ev in &events {
                        if let Event::Message { target, invoker, message } = ev {
                            let target_str = match target {
                                MessageTarget::Channel => "channel",
                                MessageTarget::Server => "server",
                                MessageTarget::Client(_) => "client",
                                MessageTarget::Poke(_) => "poke",
                            };
                            let _ = event_tx.send(bridge_proto::BridgeEvent::TextMessage {
                                client_id: invoker.id.0,
                                nickname: invoker.name.clone(),
                                text: message.clone(),
                                target: target_str,
                            });
                        }
                    }
                    for ev in events {
                        handle_event(&mut con, &mut state, own_client_id, ev)?;
                    }
                    audio::emit_state_and_roster(&mut con, event_tx, snapshot, &mut last_roster_sig, &mut last_channel_id).await;
                }
                Some(Ok(StreamItem::DisconnectedTemporarily(reason))) => {
                    warn!(?reason, "temporary disconnect");
                    // Nobody can be mid-sentence across a disconnect, and
                    // their real `SpeakerStop` is never coming — same
                    // reasoning as the `Some(Err(e))`/`None` arms below.
                    audio_state.on_disconnect(mixer, event_tx).await;
                    audio::mark_disconnected(event_tx, snapshot, &mut last_roster_sig, &mut last_channel_id).await;
                    return Err(anyhow!("temporary disconnect: {reason:?}"));
                }
                Some(Ok(other)) => {
                    handle_stream_item(&mut con, &mut state, &mut pending_avatar, other).await?;
                }
                Some(Err(e)) => {
                    audio_state.on_disconnect(mixer, event_tx).await;
                    audio::mark_disconnected(event_tx, snapshot, &mut last_roster_sig, &mut last_channel_id).await;
                    return Err(anyhow!("event stream error: {e}"));
                }
                None => {
                    audio_state.on_disconnect(mixer, event_tx).await;
                    audio::mark_disconnected(event_tx, snapshot, &mut last_roster_sig, &mut last_channel_id).await;
                    return Err(anyhow!("event stream ended"));
                }
            },
        }
    }
}

/// The non-`BookEvents`, non-`Audio` `StreamItem`s — file transfer
/// bookkeeping, command results, and the temporary-disconnect signal.
/// Split out of the main `select!` match arm so that arm reads as "one
/// wakeup source per arm", matching the other three.
async fn handle_stream_item(
    con: &mut Connection,
    state: &mut ChannelState,
    pending_avatar: &mut Option<(tsclientlib::FiletransferHandle, Vec<u8>)>,
    item: StreamItem,
) -> Result<()> {
    match item {
        StreamItem::FileUpload(handle, mut result) => {
            if let Some((pending_handle, bytes)) = pending_avatar.take() {
                if handle == pending_handle {
                    use tokio::io::AsyncWriteExt;
                    if let Err(e) = result.stream.write_all(&bytes).await {
                        error!(error = %e, "avatar upload write failed");
                    } else {
                        let _ = result.stream.shutdown().await;
                        info!("avatar upload complete");
                        let mut hasher = Md5::new();
                        hasher.update(&bytes);
                        let hash = hex_lower(&hasher.finalize());
                        match set_avatar_hash(con, &hash) {
                            Ok(handle) => {
                                info!(hash = %hash, "avatar hash sent");
                                state
                                    .pending_cmds
                                    .insert(handle.0, format!("clientupdate avatar hash {hash}"));
                            }
                            Err(e) => error!(error = %e, "set_avatar_hash failed"),
                        }
                    }
                } else {
                    *pending_avatar = Some((pending_handle, bytes));
                }
            }
        }
        // The server's verdict on a command we sent with a return code.
        // Without this a rejected channeledit looks exactly like an
        // accepted one — which is how a missing permission stayed
        // invisible while the bot logged "description updated".
        StreamItem::MessageResult(handle, res) => {
            if let Some(what) = state.pending_cmds.remove(&handle.0) {
                match res {
                    Ok(()) => info!(command = %what, "server accepted"),
                    Err(e) => error!(
                        command = %what,
                        error = %e.error,
                        missing_permission = ?e.missing_permission,
                        "SERVER REJECTED"
                    ),
                }
            }
        }
        StreamItem::FiletransferFailed(_, e) => {
            error!(error = %e, "file transfer failed");
        }
        _ => {}
    }
    Ok(())
}

fn handle_event(
    con: &mut Connection,
    state: &mut ChannelState,
    own_client_id: ClientId,
    ev: Event,
) -> Result<()> {
    match ev {
        // HARD RULE: only real user-authored text messages targeted at the
        // channel, sent by someone actually sitting in the watched channel,
        // and not the bot's own messages.
        Event::Message { target: MessageTarget::Channel, invoker, message } => {
            if invoker.id == own_client_id {
                return Ok(());
            }
            let sender_channel = con
                .get_state()
                .ok()
                .and_then(|s| s.clients.get(&invoker.id).map(|c| c.channel));
            if sender_channel != Some(state.channel_id) {
                return Ok(());
            }
            let entry = state.push(invoker.name.clone(), &message);
            if let Err(e) = state.append_disk_log(&entry) {
                error!(error = %e, "disk log append failed");
            }
            let desc = state.render_description();
            match set_description(con, state.channel_id, &desc) {
                Ok(handle) => {
                    info!(
                        from = %entry.nickname,
                        kept = state.history.len(),
                        desc_bytes = desc.len(),
                        "logged message; description edit sent"
                    );
                    state.pending_cmds.insert(
                        handle.0,
                        format!("channeledit description ({} bytes)", desc.len()),
                    );
                }
                Err(e) => warn!(error = %e, "description update failed"),
            }
        }
        // A client connected to the server and landed in a channel. If that
        // channel is the watched one, they are a joiner: catch them up.
        Event::PropertyAdded { id: PropertyId::Client(client_id), .. } => {
            maybe_send_catchup(con, state, own_client_id, client_id);
        }
        // A client moved. If they moved INTO the watched channel (and it's
        // not us), send the rate-limited catch-up PM. This is a plain move
        // event, never a join/leave/mute/away — those don't touch this path.
        Event::PropertyChanged { id: PropertyId::ClientChannel(client_id), .. } => {
            maybe_send_catchup(con, state, own_client_id, client_id);
        }
        _ => {}
    }
    Ok(())
}

/// Send the catch-up PM to `client_id` if they are now sitting in the watched
/// channel, are not us, were not already here when we connected, and have not
/// been PM'd inside the rate-limit window.
fn maybe_send_catchup(
    con: &mut Connection,
    state: &mut ChannelState,
    own_client_id: ClientId,
    client_id: ClientId,
) {
    if client_id == own_client_id || state.preexisting.contains(&client_id) {
        return;
    }
    // The initial client-list burst arrives just *after* we snapshot
    // `preexisting`, so the snapshot alone does not catch everyone who was
    // already here. Stay quiet for the first few seconds as well.
    if tokio::time::Instant::now() < state.quiet_until {
        return;
    }
    let now_in_channel = con
        .get_state()
        .ok()
        .and_then(|s| s.clients.get(&client_id).map(|c| c.channel));
    if now_in_channel != Some(state.channel_id) {
        return;
    }
    let now = tokio::time::Instant::now();
    let should_send = match state.last_pm.get(&client_id) {
        Some(last) => now.duration_since(*last) >= PM_RATE_LIMIT,
        None => true,
    };
    if !should_send {
        return;
    }
    state.last_pm.insert(client_id, now);

    // The announced notice (PHA-3305): before this client's *first* catch-up,
    // and only ever before the first, say what the Sexton is doing. The
    // rate-limit map above expires after ten minutes; this one never does.
    let (key, durable) = welcome_key(con, client_id);
    if !state.welcomed.contains(&key) {
        match send_pm(con, client_id, WELCOME_PM) {
            Ok(handle) => {
                info!(?client_id, %key, durable, "welcome PM sent");
                state.pending_cmds.insert(handle.0, format!("welcome PM to {client_id:?}"));
                state.remember_welcomed(key, durable);
            }
            // Not fatal, and deliberately not remembered: an unsent welcome
            // should be retried on their next join, not marked as delivered.
            Err(e) => warn!(error = %e, ?client_id, "welcome PM failed"),
        }
    }

    let text = state.catchup_text();
    match send_pm(con, client_id, &text) {
        Ok(handle) => {
            info!(?client_id, "catch-up PM sent");
            state.pending_cmds.insert(handle.0, format!("catch-up PM to {client_id:?}"));
        }
        Err(e) => warn!(error = %e, ?client_id, "catch-up PM failed"),
    }
}

/// The key a welcomed client is remembered under, and whether it is worth
/// writing down.
///
/// Their TeamSpeak uid is the durable one: it survives reconnects, nickname
/// changes and bot restarts, which is what "once, and it stays out" needs. If
/// the server has not handed us a uid for this client, fall back to the runtime
/// `ClientId` — good enough to stop a channel hop re-welcoming them inside this
/// session, and never persisted, where it would only collide with a stranger.
fn welcome_key(con: &mut Connection, client_id: ClientId) -> (String, bool) {
    let uid = con
        .get_state()
        .ok()
        .and_then(|s| s.clients.get(&client_id).and_then(|c| c.uid.as_ref().map(|u| u.to_string())));
    match uid {
        Some(uid) => (uid, true),
        None => (format!("client-id:{client_id}"), false),
    }
}

fn set_description(
    con: &mut Connection,
    channel_id: ChannelId,
    description: &str,
) -> Result<MessageHandle> {
    let cmd = {
        let state = con.get_state().map_err(|e| anyhow!("get_state: {e}"))?;
        let channel = state
            .channels
            .get(&channel_id)
            .ok_or_else(|| anyhow!("channel {:?} disappeared from tree", channel_id))?;
        channel.edit().set_description(description)
    };
    cmd.send_with_result(con).map_err(|e| anyhow!("channeledit: {e}"))
}

/// Retry `clientupdate client_nickname=<want>` until the server accepts it
/// or `NICKNAME_RECLAIM_TIMEOUT` elapses (PHA-3426). Unlike the initial
/// login — which silently suffixes a taken nickname instead of refusing the
/// connection — an explicit `clientupdate` while the name is still held
/// comes back as a `CommandError`, which is what we're polling away here.
async fn reclaim_nickname(con: &mut Connection, want: &str) -> Result<()> {
    let overall_deadline = tokio::time::Instant::now() + NICKNAME_RECLAIM_TIMEOUT;
    loop {
        let cmd = {
            let state = con.get_state().map_err(|e| anyhow!("get_state: {e}"))?;
            state.client_update().set_name(want)
        };
        let handle = cmd.send_with_result(con).map_err(|e| anyhow!("clientupdate nickname: {e}"))?;

        // Keep polling the event stream for the whole `wait_until` window
        // before sending the next attempt — never stop draining it (tsclientlib
        // only advances the connection, acks and resends included, while its
        // stream is being polled, so a bare `tokio::time::sleep` here starves
        // the connection instead of just pacing the retry) and never resend
        // the instant the server's rejection comes back either, since that
        // rejection is near-instant and resending on it would hammer the
        // server in a tight loop instead of waiting out the retry interval.
        let next_attempt_at = tokio::time::Instant::now() + NICKNAME_RECLAIM_RETRY_INTERVAL;
        let wait_until = next_attempt_at.min(overall_deadline);
        let mut reclaimed = false;
        loop {
            match tokio::time::timeout_at(wait_until, con.events().next()).await {
                Ok(Some(Ok(StreamItem::MessageResult(h, Ok(()))))) if h == handle => {
                    reclaimed = true;
                    break;
                }
                Ok(Some(Ok(StreamItem::MessageResult(h, Err(e))))) if h == handle => {
                    warn!(error = %e.error, nickname = %want, "nickname still unavailable; retrying");
                }
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(e))) => return Err(anyhow!("waiting for nickname rename result: {e}")),
                Ok(None) => return Err(anyhow!("stream ended while reclaiming nickname")),
                Err(_) => break, // hit wait_until
            }
        }

        if reclaimed {
            info!(nickname = %want, "nickname reclaimed");
            return Ok(());
        }
        if tokio::time::Instant::now() >= overall_deadline {
            return Err(anyhow!(
                "nickname {want:?} still unavailable after {}s",
                NICKNAME_RECLAIM_TIMEOUT.as_secs()
            ));
        }
    }
}

fn set_avatar_hash(con: &mut Connection, hash: &str) -> Result<MessageHandle> {
    let cmd = {
        let state = con.get_state().map_err(|e| anyhow!("get_state: {e}"))?;
        state.client_update().set_avatar_hash(hash)
    };
    cmd.send_with_result(con)
        .map_err(|e| anyhow!("clientupdate avatar hash: {e}"))
}

fn send_pm(con: &mut Connection, client_id: ClientId, text: &str) -> Result<MessageHandle> {
    let cmd = {
        let state = con.get_state().map_err(|e| anyhow!("get_state: {e}"))?;
        let client = state
            .clients
            .get(&client_id)
            .ok_or_else(|| anyhow!("client {:?} not found", client_id))?;
        client.send_textmessage(text)
    };
    cmd.send_with_result(con)
        .map_err(|e| anyhow!("send_textmessage: {e}"))
}

/// Apply one inbound `BridgeCommand` from a WS bridge client. Mirrors the
/// command handling the old `ts-bridge/src/ts_client.rs` did against its
/// own connection — PHA-3342 just moved it onto the Sexton's shared one.
///
/// `Join`/`Poke`/`SendText` did not already have sexton-side equivalents:
/// the text lane's `send_pm` is PM-only (`client.send_textmessage`, no
/// `MessageTarget::Channel`/`Server`/`Poke` support) and the text lane
/// never dynamically re-joins a channel after startup, so there is no
/// existing code path these would duplicate.
async fn handle_bridge_command(
    con: &mut Connection,
    own_client_id: ClientId,
    mixer: &Arc<TokioMutex<Mixer>>,
    audio_state: &mut AudioState,
    cmd: bridge_proto::BridgeCommand,
) {
    use bridge_proto::BridgeCommand;
    match cmd {
        BridgeCommand::VoiceAudio { samples } => mixer.lock().await.push_voice(&samples),
        BridgeCommand::MusicAudio { samples } => mixer.lock().await.push_music(&samples),
        BridgeCommand::MusicGain { gain } => mixer.lock().await.set_music_gain(gain),
        BridgeCommand::ClearVoice => mixer.lock().await.clear_voice(),
        // `ws_server`'s `dispatch` already handles `say_text` as a
        // log-only stub before it would ever become a `BridgeCommand` —
        // this arm exists so the match stays exhaustive if that changes
        // (e.g. once PHA-3228's TTS webhook is actually wired up).
        BridgeCommand::SayText { text } => {
            warn!(%text, "say_text received but the TTS webhook client isn't wired up yet — push voice_audio directly for now");
        }
        BridgeCommand::Join { channel } => {
            let target = con.get_state().ok().and_then(|s| audio::resolve_channel_id(s, &channel));
            match target {
                Some(channel_id) => {
                    let mut parts = std::iter::once(OutClientMovePart {
                        client_id: own_client_id,
                        channel_id,
                        channel_password: None,
                    });
                    if let Err(e) = OutClientMoveMessage::new(&mut parts).send(con) {
                        warn!(error = %e, "bridge join failed");
                    }
                }
                None => warn!(%channel, "bridge join: channel not found"),
            }
        }
        BridgeCommand::Mute { muted } => audio_state.set_muted(muted),
        BridgeCommand::Poke { client_id, text } => {
            let cmd = {
                match con.get_state() {
                    Ok(state) => state.send_message(MessageTarget::Poke(ClientId(client_id)), &text),
                    Err(e) => {
                        warn!(error = %e, "bridge poke: get_state failed");
                        return;
                    }
                }
            };
            if let Err(e) = cmd.send(con) {
                warn!(error = %e, "bridge poke failed");
            }
        }
        BridgeCommand::SendText { target, text } => {
            let msg_target = match target {
                bridge_proto::SendTarget::Channel => MessageTarget::Channel,
                bridge_proto::SendTarget::Server => MessageTarget::Server,
                bridge_proto::SendTarget::Client { id } => MessageTarget::Client(ClientId(id)),
            };
            let cmd = {
                match con.get_state() {
                    Ok(state) => state.send_message(msg_target, &text),
                    Err(e) => {
                        warn!(error = %e, "bridge send_text: get_state failed");
                        return;
                    }
                }
            };
            if let Err(e) = cmd.send(con) {
                warn!(error = %e, "bridge send_text failed");
            }
        }
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn run_on_connected_hook(path: &str) {
    let path = path.to_string();
    std::thread::spawn(move || match std::process::Command::new(&path).status() {
        Ok(status) => info!(%path, ?status, "on-connected hook finished"),
        Err(e) => error!(%path, error = %e, "on-connected hook failed to launch"),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(time: &str, nick: &str, text: &str) -> LoggedMessage {
        LoggedMessage {
            time_label: time.to_string(),
            nickname: nick.to_string(),
            text: text.to_string(),
        }
    }

    #[test]
    fn parses_what_it_renders() {
        for entry in [
            msg("18:01", "SextonTestA", "one — from A before the mute"),
            msg("00:00", "nick with spaces", "text: with a colon [and brackets]"),
            msg("23:59", "nick", ""),
        ] {
            let line = entry.render_line();
            let line = line.trim_end_matches('\n');
            assert_eq!(parse_log_line(line).as_ref(), Some(&entry), "round-trip of {line:?}");
        }
    }

    #[test]
    fn rejects_lines_that_are_not_log_lines() {
        for bad in [
            "",
            "# 2026-09-06",
            "not a log line at all",
            "18:01 SextonTestA: only one space",
            "8:01  SextonTestA: short clock",
            "18:xx  SextonTestA: not a clock",
            "18:01  : empty nickname",
        ] {
            assert!(parse_log_line(bad).is_none(), "should not parse {bad:?}");
        }
    }

    fn seeded_from(dir: &std::path::Path, channel: &str) -> Vec<LoggedMessage> {
        let mut state = ChannelState::new(
            ChannelId(0),
            channel.to_string(),
            dir.to_path_buf(),
            HashSet::new(),
        );
        state.seed_history_from_disk();
        state.history.into_iter().collect()
    }

    /// A scratch dir under the OS temp dir, keyed by test name so parallel
    /// tests don't collide. Removed and recreated on every run.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sexton-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_day(dir: &std::path::Path, channel: &str, date: chrono::NaiveDate, body: &str) {
        let day_dir = dir.join(channel);
        std::fs::create_dir_all(&day_dir).unwrap();
        std::fs::write(day_dir.join(format!("{}.md", date.format("%Y-%m-%d"))), body).unwrap();
    }

    #[test]
    fn seeds_todays_log_in_order_and_skips_junk() {
        let dir = scratch("seed-today");
        let channel = "General Shit"; // the real channel name, spaces and all
        let today = Local::now().date_naive();
        write_day(
            &dir,
            channel,
            today,
            "18:01  SextonTestA: one\n\n### hand-added heading\n18:01  SextonTestB: two\n18:01  SextonTestA: three\n",
        );

        let seeded = seeded_from(&dir, channel);
        assert_eq!(
            seeded,
            vec![
                msg("18:01", "SextonTestA", "one"),
                msg("18:01", "SextonTestB", "two"),
                msg("18:01", "SextonTestA", "three"),
            ]
        );
    }

    #[test]
    fn seeds_yesterday_before_today() {
        let dir = scratch("seed-yesterday");
        let channel = "chan";
        let today = Local::now().date_naive();
        let yesterday = today.pred_opt().unwrap();
        write_day(&dir, channel, yesterday, "23:59  A: from yesterday\n");
        write_day(&dir, channel, today, "00:01  B: from today\n");

        let seeded = seeded_from(&dir, channel);
        assert_eq!(
            seeded,
            vec![msg("23:59", "A", "from yesterday"), msg("00:01", "B", "from today")]
        );
    }

    #[test]
    fn seeding_is_trimmed_to_the_description_budget() {
        let dir = scratch("seed-budget");
        let channel = "chan";
        let today = Local::now().date_naive();
        // 400 lines of ~40 bytes each — comfortably over both the byte budget
        // and HISTORY_CAP.
        let body: String = (0..400)
            .map(|i| format!("12:00  spammer: message number {i:04} padding padding\n"))
            .collect();
        write_day(&dir, channel, today, &body);

        let seeded = seeded_from(&dir, channel);
        assert!(!seeded.is_empty(), "should have seeded something");
        assert!(seeded.len() <= HISTORY_CAP, "seeded {} > HISTORY_CAP", seeded.len());
        // The newest lines are the ones kept.
        assert_eq!(seeded.last().unwrap().text, "message number 0399 padding padding");

        let rendered: usize =
            DESC_HEADER.len() + seeded.iter().map(|e| e.render_line().len()).sum::<usize>();
        assert!(rendered <= DESC_BUDGET_BYTES, "seeded {rendered} bytes > budget");
    }

    fn state_in(dir: &std::path::Path, channel: &str) -> ChannelState {
        ChannelState::new(ChannelId(0), channel.to_string(), dir.to_path_buf(), HashSet::new())
    }

    /// The notice ships in two stages (PHA-3177). Stage 2's sentences are
    /// promises the text-only Sexton cannot keep, so this test is the guard
    /// against them arriving early by way of a well-meaning edit.
    #[test]
    fn the_notice_is_stage_one_and_carries_nothing_from_stage_two() {
        assert_eq!(
            DESC_HEADER,
            "— the Sexton keeps this hall: the last lines stay here, the whole log is kept below. \
             Ask him and he'll fetch the rest. —\n"
        );
        assert_eq!(
            WELCOME_PM,
            "Evening. I'm the Sexton — I keep the records for this hall.\n\n\
             One thing worth knowing before you settle in: everything typed in the channel goes \
             into the log, and the last twenty lines sit in the channel description where you can \
             see them.\n\n\
             Ask me for something out of the log and I'll go down and find it."
        );

        // PHA-3228 has not landed: nothing here may promise voice, or that the
        // voice never leaves the box.
        for stage_two in ["out loud", "listening", "voice", "say my name"] {
            assert!(!DESC_HEADER.contains(stage_two), "stage-2 wording {stage_two:?} in the header");
            assert!(!WELCOME_PM.contains(stage_two), "stage-2 wording {stage_two:?} in the welcome");
        }

        // The header shares the description's byte budget with the log lines.
        assert!(DESC_HEADER.len() < 200, "header is {} bytes", DESC_HEADER.len());
    }

    #[test]
    fn the_welcome_goes_out_once_and_stays_out_across_a_restart() {
        let dir = scratch("welcomed");
        let channel = "General Shit";
        let uid = "aQm5FQ0RfBBBhP0Cw0S1FCxjnbg=";

        let mut state = state_in(&dir, channel);
        assert!(!state.welcomed.contains(uid), "nobody is welcomed on a cold start");
        state.remember_welcomed(uid.to_string(), true);
        assert!(state.welcomed.contains(uid));

        // A restart: fresh state, same log dir. The welcome must not re-fire.
        let mut restarted = state_in(&dir, channel);
        restarted.load_welcomed_from_disk();
        assert!(restarted.welcomed.contains(uid), "restart forgot who it had welcomed");

        // Two clients, one file, no clobbering.
        let other = "bbbbFQ0RfBBBhP0Cw0S1FCxjnbg=";
        restarted.remember_welcomed(other.to_string(), true);
        let mut again = state_in(&dir, channel);
        again.load_welcomed_from_disk();
        assert!(again.welcomed.contains(uid) && again.welcomed.contains(other));
    }

    #[test]
    fn a_session_only_welcome_key_is_never_written_down() {
        let dir = scratch("welcomed-volatile");
        let channel = "chan";

        let mut state = state_in(&dir, channel);
        state.remember_welcomed("client-id:17".to_string(), false);
        // Held for this session...
        assert!(state.welcomed.contains("client-id:17"));
        // ...and gone on the next one: client id 17 will be someone else.
        let mut restarted = state_in(&dir, channel);
        restarted.load_welcomed_from_disk();
        assert!(restarted.welcomed.is_empty(), "a runtime client id was persisted");
    }

    #[test]
    fn an_unreadable_welcomed_list_is_fail_open() {
        // A directory where the list file should be: read_to_string errors and
        // the bot must still connect, at the cost of one repeated welcome.
        let dir = scratch("welcomed-unreadable");
        let channel = "chan";
        std::fs::create_dir_all(dir.join(channel).join(WELCOMED_FILE)).unwrap();
        let mut state = state_in(&dir, channel);
        state.load_welcomed_from_disk();
        assert!(state.welcomed.is_empty());
    }

    #[test]
    fn missing_and_unreadable_logs_are_fail_open() {
        // No log dir at all.
        let dir = scratch("seed-missing");
        assert!(seeded_from(&dir, "never-logged").is_empty());

        // A directory where the day's log file should be — read_to_string
        // errors, and seeding must still return quietly.
        let dir = scratch("seed-unreadable");
        let channel = "chan";
        let today = Local::now().date_naive();
        std::fs::create_dir_all(
            dir.join(channel).join(format!("{}.md", today.format("%Y-%m-%d"))),
        )
        .unwrap();
        assert!(seeded_from(&dir, channel).is_empty());
    }
}
