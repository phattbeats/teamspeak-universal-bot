//! The Sexton — persistent TeamSpeak channel chat logger (PHA-3099 / PHA-3173),
//! and — as of PHA-3342 — the audio/voice bridge too.
//!
//! Behaviour (see PHA-3099 for the full spec):
//! 1. Catch-up PM to any client that joins/hops into the watched channel,
//!    preceded — once per client, ever — by the welcome PM that says out
//!    loud what the Sexton does (PHA-3305). The catch-up is delta-rendered
//!    per uid and the delta position is persisted to disk (PHA-3573): a uid
//!    that has already seen everything gets no PM at all, and a bot restart
//!    does not re-blast the whole window the way an in-memory rate limit did.
//! 2. Full markdown log on disk, one file per channel per day.
//!
//! PHA-3424 removed the per-message channel description rewrite (PHA-3173) and
//! the on-connect push that went with it: every edit fired a channel-edit
//! notification sound in TS6, and the catch-up PM and disk log already cover
//! the same ground. PHA-3217's on-connect rehydration of the message ring
//! stays — it feeds the catch-up PM, not just the old description.
//!
//! HARD RULE: only real user-authored text messages sent to the watched channel
//! are logged or displayed. Joins, leaves, moves, mutes, aways, kicks, bans,
//! pokes, channel edits, server messages and the bot's own messages are never
//! logged.
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
use tracing::{debug, error, info, warn};

use tsclientlib::prelude::*;
use tsclientlib::messages::c2s::{
    OutBanClientMessage, OutBanClientPart, OutBanDelMessage, OutBanDelPart, OutBanListRequestMessage,
    OutChannelCreateMessage, OutChannelCreatePart, OutChannelDeleteMessage, OutChannelDeletePart,
    OutChannelEditMessage, OutChannelEditPart, OutChannelListRequestMessage, OutClientEditMessage,
    OutClientEditPart, OutClientKickMessage, OutClientKickPart, OutClientMoveMessage, OutClientMovePart,
    OutServerEditMessage, OutServerEditPart, OutServerGroupAddClientMessage, OutServerGroupAddClientPart,
};
use tsclientlib::{
    events::{Event, PropertyId},
    ChannelId, ClientId, Connection, Identity, MessageHandle, MessageTarget, Reason, ServerGroupId,
    StreamItem,
};

mod audio;
mod mixer;
mod protocol;
mod ws_server;

use audio::AudioState;
use mixer::Mixer;

/// First-contact PM: sent once per client, ever, immediately before their first
/// catch-up (PHA-3305). Not the catch-up PM — see `catchup_text_from`.
///
/// One line, by Brandon's call on PHA-3428 item 5. The staged wording this
/// replaces explained the log and trailed a stage 2 that would describe the
/// voice path; both are gone. Anything added back here is a promise the Sexton
/// has to keep, so the bar for a second sentence is a behaviour that already
/// ships — in particular, nothing may claim a transcript stays on the box while
/// a hosted STT sits anywhere in the path (the PHA-3228 constraint, restated as
/// a wording rule).
const WELCOME_PM: &str = "The Sexton keeps this hall.";
/// How many messages the catch-up PM includes, and the cap on how much of a
/// delta it will ever show — a uid who has been away for a week still gets
/// the last `CATCHUP_PM_COUNT`, not the whole gap (PHA-3573).
const CATCHUP_PM_COUNT: usize = 15;
/// Where the welcomed-client list lives, inside the channel's log directory.
const WELCOMED_FILE: &str = ".welcomed";
/// Where the per-uid catch-up delta index lives (PHA-3573), alongside
/// `WELCOMED_FILE`.
const CAUGHT_UP_FILE: &str = ".caught_up";
/// How many messages we keep in memory (comfortably covers the catch-up PM
/// window).
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

    /// Suppress the catch-up recap PM entirely; the one-time welcome PM
    /// still fires. For a second bot instance sitting in the same channel as
    /// the primary Sexton (Bexton) — without this, a joiner gets the same
    /// recap twice, once from each bot (PHA-3573). Also settable with the
    /// `SEXTON_NO_CATCHUP` env var (any of `1`/`true`/`yes`, case-insensitive)
    /// so a deploy script can flip it without touching the command line.
    #[arg(long, default_value_t = false)]
    no_catchup: bool,

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
    /// The one rendering of a message. The catch-up PM and the on-disk log
    /// both go through this, so `parse_log_line` can read the log back without
    /// a second serialisation format (PHA-3217).
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
    /// Clients that have already had the one-time welcome PM, keyed by
    /// TeamSpeak uid (stable across reconnects and restarts) and persisted to
    /// disk.
    welcomed: HashSet<String>,
    /// Per-uid catch-up delta index (PHA-3573): `history.len()` at the uid's
    /// last catch-up, persisted to disk alongside `welcomed`. A uid absent
    /// from this map has never been caught up (equivalent to `0`). See
    /// `catchup_text_from` for how a stale or clamped value degrades — never
    /// a crash, at worst a restart re-sends up to `CATCHUP_PM_COUNT` messages
    /// a uid already saw, which is strictly better than the whole-window
    /// re-blast an in-memory rate limit used to cause on every restart.
    caught_up: HashMap<String, usize>,
    /// Clients whose join/move event fired before tsclientlib had populated
    /// their uid. `maybe_send_catchup` defers rather than falling back to a
    /// session-bound key; `handle_event`'s generic `PropertyChanged` arm
    /// retries everyone here on the next event.
    pending_catchup: HashSet<ClientId>,
    /// PHA-3573: suppress the catch-up recap for this bot instance (the
    /// welcome PM still fires). Set from `--no-catchup` / `SEXTON_NO_CATCHUP`.
    no_catchup: bool,
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
        no_catchup: bool,
    ) -> Self {
        Self {
            channel_id,
            channel_name,
            history: VecDeque::with_capacity(HISTORY_CAP),
            welcomed: HashSet::new(),
            caught_up: HashMap::new(),
            pending_catchup: HashSet::new(),
            no_catchup,
            log_dir,
            preexisting,
            quiet_until: tokio::time::Instant::now() + STARTUP_GRACE,
            pending_cmds: HashMap::new(),
        }
    }

    fn push(&mut self, nickname: String, raw_message: &str) -> LoggedMessage {
        let text = sanitize_message(raw_message);
        let time_label = Local::now().format("%H:%M").to_string();
        let entry = LoggedMessage { time_label, nickname, text };
        self.history.push_back(entry.clone());
        while self.history.len() > HISTORY_CAP {
            self.history.pop_front();
        }
        entry
    }

    /// Seed the in-memory ring from the on-disk log so a restart does not blank
    /// the catch-up PM (PHA-3217). The ring is memory-only, so without this the
    /// first joiner after a restart gets an empty catch-up for a channel the
    /// markdown log still has the day's messages for.
    ///
    /// Yesterday's file is read first, so a restart early in the day still has
    /// something to send; the newest `HISTORY_CAP` lines win, so once today's
    /// log is long enough yesterday's drops out on its own.
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
                        warn!(error = %e, path = %path.display(), "reading the log back for the history ring failed");
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

        // Keep the newest lines the ring has room for.
        let keep = parsed.len().min(HISTORY_CAP);
        let start = parsed.len() - keep;
        for entry in parsed.drain(start..) {
            self.history.push_back(entry);
        }
        if keep > 0 || skipped > 0 {
            info!(seeded = keep, skipped, dir = %dir.display(), "rehydrated message history from disk");
        }
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

    fn caught_up_path(&self) -> PathBuf {
        self.log_dir.join(&self.channel_name).join(CAUGHT_UP_FILE)
    }

    /// Read back each uid's catch-up delta position (PHA-3573). Fail-open by
    /// contract, like `load_welcomed_from_disk`: a missing or unreadable
    /// index costs everyone one full recap, never a failed connect.
    fn load_caught_up_from_disk(&mut self) {
        let path = self.caught_up_path();
        match std::fs::read_to_string(&path) {
            Ok(body) => {
                for line in body.lines() {
                    let Some((uid, count)) = line.split_once('\t') else { continue };
                    let uid = uid.trim();
                    if uid.is_empty() {
                        continue;
                    }
                    if let Ok(count) = count.trim().parse::<usize>() {
                        self.caught_up.insert(uid.to_string(), count);
                    }
                }
                info!(
                    known = self.caught_up.len(),
                    path = %path.display(),
                    "loaded the catch-up delta index"
                );
            }
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    warn!(
                        error = %e,
                        path = %path.display(),
                        "reading the catch-up delta index failed; everyone may get a full recap once"
                    );
                }
            }
        }
    }

    /// Record that `uid` has been shown the history through `count` entries,
    /// and persist the whole index — a value map, unlike the append-only
    /// `.welcomed` list, since a uid's position changes on every catch-up
    /// rather than only ever being added once.
    fn remember_caught_up(&mut self, uid: String, count: usize) {
        self.caught_up.insert(uid, count);
        if let Err(e) = self.save_caught_up() {
            warn!(
                error = %e,
                "saving the catch-up delta index failed; a restart may re-send up to the last {CATCHUP_PM_COUNT} messages"
            );
        }
    }

    /// Sorted by uid so the file is deterministic across writes (diffable,
    /// and trivial to assert against in tests) — the map's own iteration
    /// order is not.
    fn save_caught_up(&self) -> Result<()> {
        let dir = self.log_dir.join(&self.channel_name);
        std::fs::create_dir_all(&dir).with_context(|| format!("creating log dir {}", dir.display()))?;
        let mut entries: Vec<(&String, &usize)> = self.caught_up.iter().collect();
        entries.sort_by(|a, b| a.0.cmp(b.0));
        let mut body = String::new();
        for (uid, count) in entries {
            body.push_str(&format!("{uid}\t{count}\n"));
        }
        std::fs::write(self.caught_up_path(), body)
            .with_context(|| format!("writing catch-up delta index {}", self.caught_up_path().display()))?;
        Ok(())
    }

    /// Delta-rendered catch-up: only the messages not already covered by
    /// `start` (a prior `history.len()`, `0` for a uid never caught up),
    /// capped at the last `CATCHUP_PM_COUNT` regardless of how large the gap
    /// is. Returns `None` when there is nothing new to send — the caller
    /// sends no PM at all rather than an empty one (PHA-3573).
    ///
    /// `history` is rebuilt fresh from the on-disk log on every restart
    /// (never persisted itself, see `seed_history_from_disk`), so a `start`
    /// saved before a restart is a lower bound at best against the rebuilt
    /// ring. That is fine: worst case a restart re-sends up to
    /// `CATCHUP_PM_COUNT` already-seen messages — never more, and strictly
    /// better than the whole-window re-blast this replaces.
    fn catchup_text_from(&self, start: usize) -> Option<String> {
        let n = self.history.len();
        if n == 0 {
            return (start == 0).then(|| format!("Nothing logged yet in \"{}\".", self.channel_name));
        }
        let floor = n.saturating_sub(CATCHUP_PM_COUNT);
        let effective_start = start.max(floor).min(n);
        if effective_start >= n {
            return None;
        }
        let mut out = String::new();
        for entry in self.history.iter().skip(effective_start) {
            out.push_str(&entry.render_line());
        }
        Some(out)
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

/// Past this a URL stops being readable in a one-line summary, so it collapses
/// to its domain instead (PHA-3425).
const MAX_URL_LEN: usize = 80;

/// An opaque whitespace-delimited run longer than this is not something a
/// person typed — it is an attachment token or an inlined blob. We do not know
/// every payload shape TS6 can produce, so this is the catch-all that keeps raw
/// junk out of the summaries even when it arrives untagged.
const MAX_OPAQUE_TOKEN_LEN: usize = 120;

const IMAGE_EXTS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];

fn looks_like_url(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    ["http://", "https://", "ts3file://", "www."]
        .iter()
        .any(|p| l.starts_with(p))
}

/// The host part of a URL-ish string, for the `[link: domain.tld]` fallback.
fn link_domain(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let host = rest.split('/').next()?;
    // Drop any `user:pass@` prefix and `:port` suffix.
    let host = host.split('@').last()?.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// The trailing filename of a URL-ish string, ignoring query and fragment.
/// A bare host is not a filename, so a real path segment is required.
fn link_filename(url: &str) -> Option<String> {
    let no_query = url.split(['?', '#']).next()?;
    let path = no_query.split("://").nth(1).unwrap_or(no_query);
    let (_, after_host) = path.split_once('/')?;
    let name = after_host.rsplit('/').next()?.trim();
    if name.is_empty() || name.len() > 64 || !name.contains('.') {
        return None;
    }
    let ext = name.rsplit('.').next()?;
    let plausible = (1..=5).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric());
    plausible.then(|| name.to_string())
}

/// A link short enough to read survives as-is; anything longer collapses to its
/// domain. Never returns more than one short line.
fn link_label(url: &str) -> String {
    let url = url.trim();
    if url.len() <= MAX_URL_LEN {
        return url.to_string();
    }
    match link_domain(url) {
        Some(domain) => format!("[link: {domain}]"),
        None => "[link]".to_string(),
    }
}

/// The placeholder for an attachment, chosen by extension: `[image: shot.png]`
/// for pictures, `[file: notes.pdf]` otherwise, and a bare `[image]`/`[file]`
/// when the source carries no usable name.
fn attachment_label(src: &str, assume_image: bool) -> String {
    match link_filename(src) {
        Some(name) => {
            let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            if IMAGE_EXTS.contains(&ext.as_str()) {
                format!("[image: {name}]")
            } else {
                format!("[file: {name}]")
            }
        }
        None if assume_image => "[image]".to_string(),
        None => "[file]".to_string(),
    }
}

/// Turn one TS6 `ts.file.*` attachment object into a short placeholder.
///
/// Ground truth, captured live 2026-09-12 from a real image sent in
/// `General Shit` (PHA-3425 step 1) — TS6 does **not** use BBCode for
/// attachments, it inlines a JSON object as the message body:
///
/// ```text
/// {"msg_type":"ts.file.myts","file_id":"<base64 blob>",
///  "chat_user_id":"@...:chat-7.tmspk.net","file_name":"202609~4.JPG",
///  "file_size":613563,"body":"202609~4.JPG","v2":true}
/// ```
///
/// `file_id` is a myTS chat-service handle, not a URL: there is no address a
/// tsclientlib bot can GET, so the download-and-local-copy tier of the issue
/// is not reachable for this shape and we emit the placeholder tier instead.
fn ts_file_json_label(obj: &serde_json::Value) -> Option<String> {
    let msg_type = obj.get("msg_type")?.as_str()?;
    if !msg_type.starts_with("ts.file") {
        // Some other structured payload we have not seen. Keep whatever human
        // text it carries, and never the raw object.
        let body = obj.get("body").and_then(|b| b.as_str()).unwrap_or("").trim();
        return Some(if body.is_empty() { "[attachment]".to_string() } else { body.to_string() });
    }
    let name = ["file_name", "body"]
        .iter()
        .filter_map(|k| obj.get(*k).and_then(|v| v.as_str()))
        .map(str::trim)
        .find(|n| !n.is_empty() && n.contains('.') && n.len() <= 64);
    Some(match name {
        Some(name) => {
            let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            if IMAGE_EXTS.contains(&ext.as_str()) {
                format!("[image: {name}]")
            } else {
                format!("[file: {name}]")
            }
        }
        None => "[file]".to_string(),
    })
}

/// The value of a `"key":"value"` pair, read straight out of the text.
///
/// The lenient half of the attachment handling: TS6 is the only thing writing
/// these objects and we have seen exactly one version of one of them, so a
/// payload `serde_json` rejects — a newer variant, a truncation, anything —
/// must still not be echoed raw. Structure we cannot parse is not a reason to
/// print a `file_id`.
fn scrape_json_string_field(s: &str, key: &str) -> Option<String> {
    let at = s.find(&format!("\"{key}\""))?;
    let after_colon = s[at..].find(':')? + at + 1;
    let inner = s[after_colon..].trim_start().strip_prefix('"')?;
    let end = inner.find('"')?;
    Some(inner[..end].to_string())
}

/// Placeholder for a brace-object we could not parse but that is plainly one
/// of TS6's, i.e. it carries a `msg_type`. `None` if it is not.
fn scraped_payload_label(candidate: &str) -> Option<String> {
    let msg_type = scrape_json_string_field(candidate, "msg_type")?;
    let name = ["file_name", "body"]
        .iter()
        .filter_map(|k| scrape_json_string_field(candidate, k))
        .find(|n| !n.trim().is_empty() && n.contains('.') && n.len() <= 64);
    Some(match name {
        Some(name) => {
            let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            if IMAGE_EXTS.contains(&ext.as_str()) {
                format!("[image: {name}]")
            } else {
                format!("[file: {name}]")
            }
        }
        None if msg_type.starts_with("ts.file") => "[file]".to_string(),
        None => "[attachment]".to_string(),
    })
}

/// Stand-in for a resolved attachment placeholder while the BBCode and
/// whitespace passes run. Uses control characters a chat message cannot carry,
/// and no spaces or brackets, so nothing downstream touches it.
fn placeholder_sentinel(index: usize) -> String {
    format!("\u{1}{index}\u{2}")
}

/// Byte offset just past the `}` closing the object that starts at byte 0 of
/// `s`, skipping braces that sit inside JSON strings. `None` if unbalanced.
fn json_object_end(s: &str) -> Option<usize> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (i, b) in s.as_bytes().iter().enumerate() {
        if in_string {
            match (escaped, b) {
                (true, _) => escaped = false,
                (false, b'\\') => escaped = true,
                (false, b'"') => in_string = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// Replace every inlined TS6 JSON payload in `input` with its placeholder.
///
/// The object is found by scanning for a `{` and matching braces (string-aware),
/// so it is handled wherever it sits — alone, or embedded in a rehydrated
/// history line like `04:39  kyleonrye: {"msg_type":...}`.
///
/// The placeholders themselves are `[...]`-shaped, which the BBCode pass would
/// then happily strip, so each one is parked in `placeholders` and stands in
/// the text as a sentinel that survives tag stripping and whitespace collapse.
/// [`sanitize_message`] puts them back at the very end.
fn replace_ts_file_json(input: &str, placeholders: &mut Vec<String>) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            // An unterminated object (truncated in transit) still gets read to
            // the end of the line rather than printed.
            let end = json_object_end(&input[i..]).unwrap_or(input.len() - i);
            let label = Some(end).and_then(|end| {
                let candidate = &input[i..i + end];
                serde_json::from_str::<serde_json::Value>(candidate)
                    .ok()
                    .as_ref()
                    .and_then(ts_file_json_label)
                    // Malformed, but still recognisably a TS6 payload.
                    .or_else(|| scraped_payload_label(candidate))
                    .map(|label| (label, end))
            });
            // Not a payload we recognise: leave the brace alone and let the
            // opaque-token rule downstream decide.
            if let Some((label, end)) = label {
                out.push_str(&placeholder_sentinel(placeholders.len()));
                placeholders.push(label);
                i += end;
                continue;
            }
        }
        let ch_len = input[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        out.push_str(&input[i..i + ch_len]);
        i += ch_len;
    }
    out
}

/// Strip BBCode tags, keeping the visible text. `[url=X]text[/url]` -> `text`,
/// bare `[url]X[/url]` -> `X`, both subject to the length rule in
/// [`link_label`]. `[img]` becomes a short placeholder rather than echoing the
/// source. Other tags (`[b]`, `[i]`, `[color=..]`, etc.) are dropped, keeping
/// their inner text.
fn strip_bbcode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            if let Some(close) = input[i..].find(']') {
                let tag = &input[i + 1..i + close];
                let tag_lower = tag.to_ascii_lowercase();
                let rest_lower = input[i + close + 1..].to_ascii_lowercase();
                if tag_lower.starts_with("url") {
                    // Find the matching [/url] to extract the inner text.
                    if let Some(end_tag) = rest_lower.find("[/url]") {
                        let inner = &input[i + close + 1..i + close + 1 + end_tag];
                        // `[url=X]text[/url]` keeps text and bare `[url]X[/url]`
                        // keeps X, but either way it goes through the length
                        // rule — the "text" half is very often the URL again.
                        out.push_str(&link_label(inner.trim()));
                        i = i + close + 1 + end_tag + "[/url]".len();
                        continue;
                    }
                }
                if tag_lower.starts_with("img") {
                    // `[img]SRC[/img]`, plus `[img=SRC]` with or without a
                    // closing tag. The attribute form wins when both are there.
                    let attr_src = tag_lower.starts_with("img=").then(|| tag[4..].trim());
                    if let Some(end_tag) = rest_lower.find("[/img]") {
                        let inner = &input[i + close + 1..i + close + 1 + end_tag];
                        out.push_str(&attachment_label(attr_src.unwrap_or(inner).trim(), true));
                        i = i + close + 1 + end_tag + "[/img]".len();
                        continue;
                    }
                    if let Some(src) = attr_src {
                        out.push_str(&attachment_label(src, true));
                        i += close + 1;
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

/// Apply the length rules to anything that survived untagged: a bare URL the
/// user just typed, and any opaque run too long to be real prose.
fn squash_bare_tokens(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for (n, token) in input.split(' ').enumerate() {
        if n > 0 {
            out.push(' ');
        }
        if looks_like_url(token) {
            out.push_str(&link_label(token));
        } else if token.len() > MAX_OPAQUE_TOKEN_LEN {
            out.push_str(&attachment_label(token, false));
        } else {
            out.push_str(token);
        }
    }
    out
}

/// The single choke point for turning a raw TS6 message into something a
/// summary, a log line or the voice lane can read: tags resolved, attachments
/// and images reduced to short placeholders, long links reduced to their
/// domain, and the whole thing guaranteed to be one line (PHA-3425).
fn sanitize_message(input: &str) -> String {
    // Newlines first — a summary line has to stay a single line.
    let flattened = input.replace(['\r', '\n', '\t'], " ");
    // TS6's own attachment shape is an inlined JSON object, so it has to be
    // resolved before BBCode stripping mangles its punctuation.
    let mut placeholders = Vec::new();
    let unpacked = replace_ts_file_json(&flattened, &mut placeholders);
    let squashed = squash_bare_tokens(&strip_bbcode(&unpacked));
    // Collapse the whitespace runs that dropped tags and the newline swap leave.
    let mut out = squashed.split_whitespace().collect::<Vec<_>>().join(" ");
    for (index, label) in placeholders.iter().enumerate() {
        out = out.replace(&placeholder_sentinel(index), label);
    }
    out
}

/// A boolean env var, tolerant of the handful of truthy spellings a deploy
/// script actually exports (`1`, `true`, `yes`, any case) rather than
/// `bool::from_str`, which only accepts the literal `"true"` — `1` is the
/// form the Bexton deploy config uses for `SEXTON_NO_CATCHUP`.
fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
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
    loop {
        match run_once(&args, &address, &mixer, &mut cmd_rx, &event_tx, &snapshot).await {
            Ok(()) => {
                // Clean disconnect (shouldn't normally happen) — reset backoff.
                backoff = BACKOFF_INITIAL;
            }
            Err(e) => {
                error!(error = %e, next_retry_in_secs = backoff.as_secs(), "connection died; will retry after backoff");
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
    mixer: &Arc<TokioMutex<Mixer>>,
    cmd_rx: &mut mpsc::UnboundedReceiver<bridge_proto::BridgeCommand>,
    event_tx: &broadcast::Sender<bridge_proto::BridgeEvent>,
    snapshot: &Arc<TokioMutex<bridge_proto::Snapshot>>,
) -> Result<()> {
    let identity = if args.identity.is_empty() {
        let id = Identity::create();
        // PHA-3554: print the identity in the "<counter>V<key>" form that
        // `--identity` / `Identity::new_from_str` reads back, so a first boot
        // with no identity file can actually be pinned. Before this the
        // warning said "pin this" and printed nothing to pin; Bexton's first
        // boot came up as an unpinnable stranger.
        warn!(
            identity = %format!("{}V{}", id.counter(), id.key().to_ts()),
            "no identity supplied; generated a new one — write it to the identity file before the next restart"
        );
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

    let no_catchup = args.no_catchup || env_flag("SEXTON_NO_CATCHUP");
    if no_catchup {
        info!("SEXTON_NO_CATCHUP / --no-catchup set: catch-up recap PMs suppressed, welcome still fires");
    }
    let mut state = ChannelState::new(
        channel_id,
        args.channel.clone(),
        args.log_dir.clone(),
        preexisting,
        no_catchup,
    );

    // Rehydrate the ring from disk so a restart still has history to catch
    // joiners up with (PHA-3217). The description is gone, but the catch-up PM
    // reads the same ring, so dropping this would silently make the first PM
    // after every restart empty.
    state.seed_history_from_disk();
    // And who has already been introduced to the Sexton, so a restart does not
    // re-welcome the room (PHA-3305).
    state.load_welcomed_from_disk();
    // And each uid's catch-up delta position, so a restart does not re-blast
    // the whole window either (PHA-3573).
    state.load_caught_up_from_disk();

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
    // `Burst`, not `Skip`. `on_tick` pops exactly one 20 ms frame from the
    // mixer and emits one Opus packet, so the tick rate *is* the playout
    // clock. Under `Skip` a stalled loop — four speakers waking the event
    // branch while whisper pegs the box — silently retires the missed ticks,
    // and the queue then drains slower than real time forever: the listener's
    // jitter buffer underruns and conceals the gaps, which is what made the
    // voice warble and stutter (PHA-3428, Brandon 2026-09-13). `Burst` pays
    // the backlog off in a catch-up run so the average frame rate stays 50/s;
    // the bunched packets land inside the receiver's jitter buffer instead of
    // starving it.
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);

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
                    handle_bridge_command(&mut con, own_client_id, mixer, &mut audio_state, event_tx, cmd)
                        .await;
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
                            // PHA-3425 step 1: the one place the untouched TS6
                            // payload is visible. Run with
                            // `RUST_LOG=sexton=debug` to capture the real
                            // shapes for an inline image, a file attachment and
                            // a link before widening the parser above.
                            debug!(raw = %message, target = target_str, "raw text message payload");
                            let _ = event_tx.send(bridge_proto::BridgeEvent::TextMessage {
                                client_id: invoker.id.0,
                                nickname: invoker.name.clone(),
                                // Sanitized, not raw: the voice and
                                // what_did_i_miss lanes read this and must get
                                // the same placeholders the summaries show.
                                text: sanitize_message(message),
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
        // Without this a rejected command looks exactly like an accepted
        // one — which is how a missing permission used to stay invisible.
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
            info!(from = %entry.nickname, kept = state.history.len(), "logged message");
        }
        // A client connected to the server and landed in a channel. If that
        // channel is the watched one, they are a joiner: catch them up.
        Event::PropertyAdded { id: PropertyId::Client(client_id), .. } => {
            maybe_send_catchup(con, state, own_client_id, client_id);
        }
        // A client moved. If they moved INTO the watched channel (and it's
        // not us), send the catch-up PM. This is a plain move event, never a
        // join/leave/mute/away — those don't touch this path.
        Event::PropertyChanged { id: PropertyId::ClientChannel(client_id), .. } => {
            maybe_send_catchup(con, state, own_client_id, client_id);
        }
        // Any other property change is a nudge to retry whoever is still
        // waiting on their uid (PHA-3573) — tsclientlib does not always have
        // it populated by the time the join/move event above fires.
        Event::PropertyChanged { .. } => {
            retry_pending_catchups(con, state, own_client_id);
        }
        _ => {}
    }
    Ok(())
}

/// Send the catch-up PM to `client_id` if they are now sitting in the watched
/// channel, are not us, and were not already here when we connected.
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
        // Not here any more (or the event is stale) — nothing pending for
        // them is still worth retrying.
        state.pending_catchup.remove(&client_id);
        return;
    }

    // PHA-3573: the uid is the only key both the welcome and the catch-up
    // delta index trust. If the server has not handed tsclientlib one for
    // this client yet, defer instead of falling back to a session-bound key
    // that would orphan the index on every reconnect — `retry_pending_catchups`
    // tries again on the next event.
    let uid = con
        .get_state()
        .ok()
        .and_then(|s| s.clients.get(&client_id).and_then(|c| c.uid.as_ref().map(|u| u.to_string())));
    let Some(uid) = uid else {
        state.pending_catchup.insert(client_id);
        return;
    };
    state.pending_catchup.remove(&client_id);

    // The announced notice (PHA-3305): before this client's *first* catch-up,
    // and only ever before the first, say what the Sexton is doing.
    // PHA-3818: a persona bot that isn't the Sexton (Lexton) must not greet
    // joiners with "The Sexton keeps this hall." SEXTON_NO_WELCOME drops the
    // welcome PM entirely, same env-flag convention as SEXTON_NO_CATCHUP.
    if !state.welcomed.contains(&uid) && !env_flag("SEXTON_NO_WELCOME") {
        match send_pm(con, client_id, WELCOME_PM) {
            Ok(handle) => {
                info!(?client_id, %uid, "welcome PM sent");
                state.pending_cmds.insert(handle.0, format!("welcome PM to {client_id:?}"));
                state.remember_welcomed(uid.clone(), true);
            }
            // Not fatal, and deliberately not remembered: an unsent welcome
            // should be retried on their next join, not marked as delivered.
            Err(e) => warn!(error = %e, ?client_id, "welcome PM failed"),
        }
    }

    // PHA-3573: a second bot instance in the same channel (Bexton) still
    // sends the welcome above, but never the recap — otherwise a joiner gets
    // the same recap twice, once from each bot.
    if state.no_catchup {
        return;
    }

    let start = state.caught_up.get(&uid).copied().unwrap_or(0);
    match state.catchup_text_from(start) {
        Some(text) => match send_pm(con, client_id, &text) {
            Ok(handle) => {
                info!(?client_id, "catch-up PM sent");
                state.pending_cmds.insert(handle.0, format!("catch-up PM to {client_id:?}"));
                // Only advance the index on a confirmed send: same rule the
                // welcome PM above follows, and for the same reason — an
                // unsent catch-up must be retried on the next join, not
                // marked as delivered.
                state.remember_caught_up(uid, state.history.len());
            }
            Err(e) => warn!(error = %e, ?client_id, "catch-up PM failed"),
        },
        // Nothing to send, so nothing to retry either — still worth
        // normalising the stored position in case it predates a log
        // rotation that shrank `history.len()`.
        None => {
            info!(?client_id, %uid, "nothing new since their last catch-up; skipping the PM");
            state.remember_caught_up(uid, state.history.len());
        }
    }
}

/// Retry catch-ups deferred because the server had not yet told us the
/// client's uid (PHA-3573). Cheap when `pending_catchup` is empty, which is
/// the overwhelmingly common case.
fn retry_pending_catchups(con: &mut Connection, state: &mut ChannelState, own_client_id: ClientId) {
    if state.pending_catchup.is_empty() {
        return;
    }
    let pending: Vec<ClientId> = state.pending_catchup.iter().copied().collect();
    for client_id in pending {
        maybe_send_catchup(con, state, own_client_id, client_id);
    }
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
    event_tx: &broadcast::Sender<bridge_proto::BridgeEvent>,
    cmd: bridge_proto::BridgeCommand,
) {
    use bridge_proto::BridgeCommand;
    use bridge_proto::BridgeEvent::ModerationResult;
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

        // --- moderation (PHA-3786) ------------------------------------------
        BridgeCommand::ClientKick { client_id, from_server, reason } => {
            let reason_kind = if from_server { Reason::KickServer } else { Reason::KickChannel };
            let cmd = OutClientKickMessage::new(&mut std::iter::once(bridge_proto_client_kick_part(
                client_id,
                reason_kind,
                reason.as_deref(),
            )));
            let (ok, detail) = match cmd.send(con) {
                Ok(()) => (true, format!("kicked client {client_id} ({})", if from_server { "server" } else { "channel" })),
                Err(e) => (false, format!("client_kick failed: {e}")),
            };
            let _ = event_tx.send(ModerationResult { action: "client_kick", ok, detail });
        }
        BridgeCommand::BanClient { client_id, duration_secs, reason } => {
            let part = OutBanClientPart {
                client_id: ClientId(client_id),
                // `OutBanClientPart::time` is a `time::Duration` (the `time` 0.3 crate
                // tsclientlib generates its message structs against), not `std`'s.
                time: duration_secs.map(|s| time::Duration::seconds(s as i64)),
                ban_reason: reason.as_deref().map(std::borrow::Cow::Borrowed),
            };
            let cmd = OutBanClientMessage::new(&mut std::iter::once(part));
            let (ok, detail) = match cmd.send(con) {
                Ok(()) => (true, format!("banned client {client_id}")),
                Err(e) => (false, format!("ban_client failed: {e}")),
            };
            let _ = event_tx.send(ModerationResult { action: "ban_client", ok, detail });
        }
        BridgeCommand::BanDel { ban_id } => {
            let cmd = OutBanDelMessage::new(&mut std::iter::once(OutBanDelPart { ban_id }));
            let (ok, detail) = match cmd.send(con) {
                Ok(()) => (true, format!("removed ban {ban_id}")),
                Err(e) => (false, format!("ban_del failed: {e}")),
            };
            let _ = event_tx.send(ModerationResult { action: "ban_del", ok, detail });
        }
        BridgeCommand::BanList => {
            // Fire-and-forget: the response arrives as a `banlist` notify
            // event this codebase has no listener for yet (same gap noted
            // on `SayText` above). We report the request as sent, not the
            // contents.
            let cmd = OutBanListRequestMessage::new();
            let (ok, detail) = match cmd.send(con) {
                Ok(()) => (
                    true,
                    "ban list requested; response parsing is not wired up yet".to_string(),
                ),
                Err(e) => (false, format!("ban_list request failed: {e}")),
            };
            let _ = event_tx.send(ModerationResult { action: "ban_list", ok, detail });
        }
        BridgeCommand::ClientMove { client_id, channel_id } => {
            let part = OutClientMovePart {
                client_id: ClientId(client_id),
                channel_id: ChannelId(channel_id),
                channel_password: None,
            };
            let cmd = OutClientMoveMessage::new(&mut std::iter::once(part));
            let (ok, detail) = match cmd.send(con) {
                Ok(()) => (true, format!("moved client {client_id} to channel {channel_id}")),
                Err(e) => (false, format!("client_move failed: {e}")),
            };
            let _ = event_tx.send(ModerationResult { action: "client_move", ok, detail });
        }
        BridgeCommand::ClientEditMute { client_id, muted } => {
            let part = OutClientEditPart {
                client_id: ClientId(client_id),
                description: None,
                talk_power_granted: Some(!muted),
            };
            let cmd = OutClientEditMessage::new(&mut std::iter::once(part));
            let (ok, detail) = match cmd.send(con) {
                Ok(()) => (
                    true,
                    format!("{} client {client_id} (talk power)", if muted { "muted" } else { "unmuted" }),
                ),
                Err(e) => (false, format!("client_edit_mute failed: {e}")),
            };
            let _ = event_tx.send(ModerationResult { action: "client_edit_mute", ok, detail });
        }
        BridgeCommand::ChannelEdit { channel_id, name, topic } => {
            // `OutChannelEditPart` has no `Default` impl (it is a generated,
            // all-`Option` struct save `channel_id`) so every field beyond
            // `name`/`topic` — the only ones this tool exposes — is spelled
            // out as `None`.
            let part = OutChannelEditPart {
                channel_id: ChannelId(channel_id),
                order: None,
                name: name.as_deref().map(std::borrow::Cow::Borrowed),
                topic: topic.as_deref().map(std::borrow::Cow::Borrowed),
                is_default: None,
                has_password: None,
                password: None,
                is_permanent: None,
                is_semi_permanent: None,
                codec: None,
                codec_quality: None,
                needed_talk_power: None,
                max_clients: None,
                max_family_clients: None,
                codec_latency_factor: None,
                is_unencrypted: None,
                delete_delay: None,
                is_max_clients_unlimited: None,
                is_max_family_clients_unlimited: None,
                inherits_max_family_clients: None,
                phonetic_name: None,
                description: None,
            };
            let cmd = OutChannelEditMessage::new(&mut std::iter::once(part));
            let (ok, detail) = match cmd.send(con) {
                Ok(()) => (true, format!("edited channel {channel_id}")),
                Err(e) => (false, format!("channel_edit failed: {e}")),
            };
            let _ = event_tx.send(ModerationResult { action: "channel_edit", ok, detail });
        }
        BridgeCommand::ChannelCreate { name, parent_id } => {
            // Same "no Default" situation as `ChannelEdit` above — only
            // `name` and `parent_id` are exposed to the tool, the rest of
            // this generated struct's fields are spelled out as `None`.
            let part = OutChannelCreatePart {
                parent_id: parent_id.map(ChannelId),
                name: std::borrow::Cow::Borrowed(name.as_str()),
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
                is_permanent: None,
                is_semi_permanent: None,
                is_default: None,
            };
            let cmd = OutChannelCreateMessage::new(&mut std::iter::once(part));
            let (ok, detail) = match cmd.send(con) {
                Ok(()) => (true, format!("created channel {name:?}")),
                Err(e) => (false, format!("channel_create failed: {e}")),
            };
            let _ = event_tx.send(ModerationResult { action: "channel_create", ok, detail });
        }
        BridgeCommand::ChannelDelete { channel_id, force } => {
            let part = OutChannelDeletePart { channel_id: ChannelId(channel_id), force };
            let cmd = OutChannelDeleteMessage::new(&mut std::iter::once(part));
            let (ok, detail) = match cmd.send(con) {
                Ok(()) => (true, format!("deleted channel {channel_id}")),
                Err(e) => (false, format!("channel_delete failed: {e}")),
            };
            let _ = event_tx.send(ModerationResult { action: "channel_delete", ok, detail });
        }
        BridgeCommand::ServerEdit { name, welcome_message } => {
            // Same "no Default" situation — only `name`/`welcome_message`
            // are exposed to the tool, the rest of this 43-field generated
            // struct is spelled out as `None`.
            let part = OutServerEditPart {
                server_id: None,
                name: name.as_deref().map(std::borrow::Cow::Borrowed),
                welcome_message: welcome_message.as_deref().map(std::borrow::Cow::Borrowed),
                max_clients: None,
                password: None,
                hostmessage: None,
                hostmessage_mode: None,
                hostbanner_url: None,
                hostbanner_gfx_url: None,
                hostbanner_gfx_interval: None,
                hostbutton_tooltip: None,
                hostbutton_url: None,
                hostbutton_gfx_url: None,
                icon: None,
                reserved_slots: None,
                hostbanner_mode: None,
                nickname: None,
                max_download_bandwidth_total: None,
                max_upload_bandwidth_total: None,
                download_quota: None,
                upload_quota: None,
                antiflood_points_tick_reduce: None,
                antiflood_points_to_command_block: None,
                antiflood_points_to_ip_block: None,
                codec_encryption_mode: None,
                needed_identity_security_level: None,
                default_server_group: None,
                default_channel_group: None,
                default_channel_admin_group: None,
                complain_autoban_count: None,
                complain_autoban_time: None,
                complain_remove_time: None,
                min_clients_in_channel_before_forced_silence: None,
                priority_speaker_dimm_modificator: None,
                phonetic_name: None,
                temp_channel_default_delete_delay: None,
                weblist_enabled: None,
                log_client: None,
                log_query: None,
                log_channel: None,
                log_permissions: None,
                log_server: None,
                log_filetransfer: None,
            };
            let cmd = OutServerEditMessage::new(&mut std::iter::once(part));
            let (ok, detail) = match cmd.send(con) {
                Ok(()) => (true, "edited server".to_string()),
                Err(e) => (false, format!("server_edit failed: {e}")),
            };
            let _ = event_tx.send(ModerationResult { action: "server_edit", ok, detail });
        }
        BridgeCommand::ServerGroupAddClient { server_group_id, client_id } => {
            let client_db_id = match con.get_state() {
                Ok(state) => state.clients.get(&ClientId(client_id)).map(|c| c.database_id),
                Err(e) => {
                    warn!(error = %e, "bridge servergroupaddclient: get_state failed");
                    None
                }
            };
            let (ok, detail) = match client_db_id {
                Some(client_db_id) => {
                    let part = OutServerGroupAddClientPart {
                        server_group_id: ServerGroupId(server_group_id),
                        client_db_id,
                    };
                    let cmd = OutServerGroupAddClientMessage::new(&mut std::iter::once(part));
                    match cmd.send(con) {
                        Ok(()) => (true, format!("added client {client_id} to group {server_group_id}")),
                        Err(e) => (false, format!("servergroupaddclient failed: {e}")),
                    }
                }
                None => (false, format!("client {client_id} not found; cannot resolve database id")),
            };
            let _ = event_tx.send(ModerationResult { action: "server_group_add_client", ok, detail });
        }
        BridgeCommand::ListChannels => {
            match con.get_state() {
                Ok(state) => {
                    let tree = audio::build_channel_tree(state);
                    let _ = event_tx.send(bridge_proto::BridgeEvent::ChannelTree(tree));
                }
                Err(e) => warn!(error = %e, "bridge list_channels: get_state failed"),
            }
        }
    }
}

/// `OutClientKickPart` borrows its `reason_message`, so this stays a
/// standalone helper rather than inlining into the match arm above — keeps
/// the borrow scoped to one expression per PHA-3786 kick call.
fn bridge_proto_client_kick_part(
    client_id: u16,
    reason: Reason,
    reason_message: Option<&str>,
) -> OutClientKickPart<'_> {
    OutClientKickPart {
        client_id: ClientId(client_id),
        reason,
        reason_message: reason_message.map(std::borrow::Cow::Borrowed),
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
            false,
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
    fn seeding_is_trimmed_to_the_history_cap() {
        let dir = scratch("seed-budget");
        let channel = "chan";
        let today = Local::now().date_naive();
        // 400 lines — comfortably over HISTORY_CAP.
        let body: String = (0..400)
            .map(|i| format!("12:00  spammer: message number {i:04} padding padding\n"))
            .collect();
        write_day(&dir, channel, today, &body);

        let seeded = seeded_from(&dir, channel);
        assert!(!seeded.is_empty(), "should have seeded something");
        assert!(seeded.len() <= HISTORY_CAP, "seeded {} > HISTORY_CAP", seeded.len());
        // The newest lines are the ones kept.
        assert_eq!(seeded.last().unwrap().text, "message number 0399 padding padding");
        assert_eq!(seeded.len(), HISTORY_CAP);
    }

    fn state_in(dir: &std::path::Path, channel: &str) -> ChannelState {
        ChannelState::new(ChannelId(0), channel.to_string(), dir.to_path_buf(), HashSet::new(), false)
    }

    /// The welcome PM is one line, by Brandon's call on PHA-3428 item 5. The
    /// staging guards below outlive the staged wording: they exist so a
    /// well-meaning edit cannot quietly add a promise the Sexton does not keep.
    #[test]
    fn the_welcome_pm_is_stage_one_and_carries_nothing_from_stage_two() {
        assert_eq!(WELCOME_PM, "The Sexton keeps this hall.");

        // PHA-3424 removed the rolling channel description; the welcome must
        // not keep pointing people at it.
        assert!(!WELCOME_PM.contains("description"), "welcome still points at the description");

        // PHA-3228 has not landed: nothing here may promise voice, or that the
        // voice never leaves the box.
        for stage_two in ["out loud", "listening", "voice", "say my name"] {
            assert!(!WELCOME_PM.contains(stage_two), "stage-2 wording {stage_two:?} in the welcome");
        }
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

    /// `start` at (or past) the current history length means the uid has
    /// already seen everything: no PM at all, not an empty one (PHA-3573,
    /// replacing the old in-memory rate limit's job).
    #[test]
    fn catchup_text_from_with_full_coverage_is_empty() {
        let mut state = state_in(&scratch("catchup-full-coverage"), "chan");
        for i in 0..5 {
            state.push("nick".to_string(), &format!("message {i}"));
        }
        let n = state.history.len();
        assert!(state.catchup_text_from(n).is_none(), "full coverage must skip the PM entirely");
    }

    /// The normal case: a uid rejoins after missing a handful of messages and
    /// gets exactly those, not the last 15 and not the ones it already saw.
    #[test]
    fn catchup_text_from_sends_only_new_messages_since_start() {
        let mut state = state_in(&scratch("catchup-delta"), "chan");
        for i in 0..5 {
            state.push("nick".to_string(), &format!("message {i}"));
        }
        let text = state.catchup_text_from(3).expect("2 new messages exist");
        for already_seen in ["message 0", "message 1", "message 2"] {
            assert!(!text.contains(already_seen), "{already_seen:?} was already seen");
        }
        for new in ["message 3", "message 4"] {
            assert!(text.contains(new), "{new:?} is new and must be included");
        }
    }

    /// A uid never caught up (`start == 0`) gets the same last-15 window the
    /// old unconditional `catchup_text` always sent — the "brand new joiner"
    /// case must not regress into an unbounded dump of the whole channel.
    #[test]
    fn catchup_text_from_zero_returns_last_15() {
        let mut state = state_in(&scratch("catchup-zero"), "chan");
        for i in 0..40 {
            state.push("nick".to_string(), &format!("message {i:03}"));
        }
        let text = state.catchup_text_from(0).expect("history is not empty");
        assert_eq!(text.lines().count(), CATCHUP_PM_COUNT);
        assert!(text.contains("message 039"), "must include the newest message");
        assert!(text.contains("message 025"), "must include exactly the last 15");
        assert!(!text.contains("message 024"), "must not include more than the last 15");
    }

    /// Regression target for PHA-3573: the whole point of persisting the
    /// index is that a bot restart does not forget a uid's position and
    /// re-blast the window, the way the in-memory-only rate limit used to.
    #[test]
    fn caught_up_survives_restart() {
        let dir = scratch("caught-up-restart");
        let channel = "chan";
        let uid = "aQm5FQ0RfBBBhP0Cw0S1FCxjnbg=".to_string();

        let mut state = state_in(&dir, channel);
        for i in 0..5 {
            state.push("nick".to_string(), &format!("message {i}"));
        }
        assert!(state.caught_up.get(&uid).is_none(), "nothing caught up on a cold start");
        state.remember_caught_up(uid.clone(), state.history.len());
        assert_eq!(state.caught_up.get(&uid), Some(&5));

        // A restart: fresh state, same log dir.
        let mut restarted = state_in(&dir, channel);
        restarted.load_caught_up_from_disk();
        assert_eq!(restarted.caught_up.get(&uid), Some(&5), "restart forgot the uid's position");
    }

    #[test]
    fn an_unreadable_caught_up_file_is_fail_open() {
        // A directory where the index file should be: read_to_string errors
        // and the bot must still connect, at the cost of one repeated recap.
        let dir = scratch("caught-up-unreadable");
        let channel = "chan";
        std::fs::create_dir_all(dir.join(channel).join(CAUGHT_UP_FILE)).unwrap();
        let mut state = state_in(&dir, channel);
        state.load_caught_up_from_disk();
        assert!(state.caught_up.is_empty());
    }

    #[test]
    fn missing_caught_up_file_is_fail_open() {
        let dir = scratch("caught-up-missing");
        let mut state = state_in(&dir, "chan");
        state.load_caught_up_from_disk();
        assert!(state.caught_up.is_empty());
    }

    #[test]
    fn caught_up_save_is_sorted_by_uid() {
        let dir = scratch("caught-up-sorted");
        let channel = "chan";
        let mut state = state_in(&dir, channel);
        state.remember_caught_up("zzz-last".to_string(), 3);
        state.remember_caught_up("aaa-first".to_string(), 7);
        state.remember_caught_up("mmm-middle".to_string(), 1);

        let body = std::fs::read_to_string(dir.join(channel).join(CAUGHT_UP_FILE)).unwrap();
        let uids: Vec<&str> = body.lines().map(|l| l.split('\t').next().unwrap()).collect();
        assert_eq!(uids, vec!["aaa-first", "mmm-middle", "zzz-last"]);
    }

    /// `SEXTON_NO_CATCHUP` is exported by the Bexton deploy config as `1`,
    /// not Rust's `bool::from_str`-only `"true"` — this is the whole reason
    /// `--no-catchup` reads it through `env_flag` instead of clap's own env
    /// binding.
    #[test]
    fn env_flag_accepts_common_truthy_spellings() {
        const VAR: &str = "SEXTON_TEST_NO_CATCHUP_FLAG";
        for v in ["1", "true", "TRUE", "yes", "YES"] {
            std::env::set_var(VAR, v);
            assert!(env_flag(VAR), "{v:?} should be truthy");
        }
        for v in ["0", "false", "", "no"] {
            std::env::set_var(VAR, v);
            assert!(!env_flag(VAR), "{v:?} should not be truthy");
        }
        std::env::remove_var(VAR);
        assert!(!env_flag(VAR), "unset should not be truthy");
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
    fn a_short_link_survives_but_a_long_one_becomes_its_domain() {
        let short = "https://phatt.tech/blog";
        assert_eq!(sanitize_message(short), short);
        assert_eq!(sanitize_message(&format!("look at [url]{short}[/url]")), format!("look at {short}"));

        // Past MAX_URL_LEN nothing but the domain is worth reading.
        let long = format!("https://tracking.example.com/watch?v=abc&{}", "q=1&".repeat(40));
        assert!(long.len() > MAX_URL_LEN);
        assert_eq!(sanitize_message(&long), "[link: tracking.example.com]");
        assert_eq!(sanitize_message(&format!("[url]{long}[/url]")), "[link: tracking.example.com]");
    }

    #[test]
    fn link_text_is_kept_when_it_is_actually_words() {
        assert_eq!(
            sanitize_message("[url=https://phatt.tech/a/very/long/path/that/keeps/going/on]the writeup[/url]"),
            "the writeup"
        );
    }

    #[test]
    fn images_and_files_become_short_placeholders() {
        assert_eq!(
            sanitize_message("[img]https://ts.example.com/files/2026/shot.png[/img]"),
            "[image: shot.png]"
        );
        // The attribute form, and a source with no usable filename.
        assert_eq!(sanitize_message("[img=https://cdn.example.com/a/b.jpg]x[/img]"), "[image: b.jpg]");
        assert_eq!(sanitize_message("[img]https://cdn.example.com[/img]"), "[image]");
        // A non-image extension reads as a file, not an image.
        assert_eq!(
            sanitize_message("here [img]ts3file://server/files/notes.pdf[/img]"),
            "here [file: notes.pdf]"
        );
    }

    /// The real payload TS6 sent for an image posted in `General Shit`,
    /// captured from the live raw-payload log on 2026-09-12. Verbatim except
    /// for the shortened `file_id`.
    const REAL_TS6_IMAGE_PAYLOAD: &str = r#"{"msg_type":"ts.file.myts","file_id":"YnlkanZud3lnanRuc3d3eHFpcHljaHdyemdkYmZtdnNwbmJrdGtkb2dlYXZva2xjdGJyZm1ob3Z4Y2Zn","chat_user_id":"@aetojq5cdrys7ys2mc6jy2s5yunxuapnhceygtqjyqczqbvuuaua4===:chat-7.tmspk.net","file_name":"202609~4.JPG","file_size":613563,"body":"202609~4.JPG","v2":true}"#;

    #[test]
    fn the_real_ts6_attachment_payload_becomes_a_placeholder() {
        assert_eq!(sanitize_message(REAL_TS6_IMAGE_PAYLOAD), "[image: 202609~4.JPG]");
        // Same shape with a non-image name reads as a file...
        let doc = REAL_TS6_IMAGE_PAYLOAD.replace("202609~4.JPG", "quarterly.pdf");
        assert_eq!(sanitize_message(&doc), "[file: quarterly.pdf]");
        // ...and it is still handled when it arrives embedded in other text,
        // as it does on the rehydrated-history path.
        assert_eq!(
            sanitize_message(&format!("04:39  kyleonrye: {REAL_TS6_IMAGE_PAYLOAD}")),
            "04:39 kyleonrye: [image: 202609~4.JPG]"
        );
        // Nothing of the raw object survives — no file_id, no chat_user_id.
        let out = sanitize_message(REAL_TS6_IMAGE_PAYLOAD);
        assert!(!out.contains("msg_type") && !out.contains("chat-7") && !out.contains("file_id"));
    }

    #[test]
    fn a_payload_that_does_not_parse_is_still_not_echoed_raw() {
        // We have seen exactly one version of one of these objects. A variant
        // strict JSON rejects must not fall through to the raw line — this one
        // has its separators mangled.
        let mangled = REAL_TS6_IMAGE_PAYLOAD.replace(",", " ");
        assert!(serde_json::from_str::<serde_json::Value>(&mangled).is_err());
        let out = sanitize_message(&mangled);
        assert_eq!(out, "[image: 202609~4.JPG]");
        assert!(!out.contains("file_id") && !out.contains("chat-7"));
        // A truncated one keeps whatever name it got as far as.
        let truncated = &REAL_TS6_IMAGE_PAYLOAD[..REAL_TS6_IMAGE_PAYLOAD.len() - 30];
        assert!(!sanitize_message(truncated).contains("YnlkanZud3ln"));
    }

    #[test]
    fn an_unknown_structured_payload_keeps_only_its_body() {
        assert_eq!(
            sanitize_message(r#"{"msg_type":"ts.poll.v1","poll_id":"abc","body":"who is in?"}"#),
            "who is in?"
        );
        assert_eq!(sanitize_message(r#"{"msg_type":"ts.unknown","blob":"xyz"}"#), "[attachment]");
        // Prose that merely contains braces is not a payload and is untouched.
        assert_eq!(sanitize_message("use {braces} like this"), "use {braces} like this");
    }

    #[test]
    fn an_untagged_attachment_token_never_reaches_the_summary() {
        // We do not know every shape TS6 can send, so an opaque run that long
        // is replaced whatever it turns out to be.
        let token = "A".repeat(MAX_OPAQUE_TOKEN_LEN + 1);
        assert_eq!(sanitize_message(&format!("sent {token}")), "sent [file]");
        // ...while ordinary prose of the same total length is untouched.
        let prose = "word ".repeat(40);
        assert_eq!(sanitize_message(&prose), prose.trim());
    }

    #[test]
    fn a_sanitized_message_is_always_one_line() {
        let multi = "first line\r\nsecond\tline\n\n   third";
        let out = sanitize_message(multi);
        assert_eq!(out, "first line second line third");
        assert!(!out.contains('\n') && !out.contains('\r') && !out.contains('\t'));
    }

    #[test]
    fn plain_formatting_still_reduces_to_its_text() {
        // The pre-PHA-3425 behaviour these changes must not regress.
        assert_eq!(sanitize_message("[b]bold[/b] and [color=#fff]red[/color]"), "bold and red");
        assert_eq!(sanitize_message("no tags at all"), "no tags at all");
        assert_eq!(sanitize_message("unclosed [bracket"), "unclosed [bracket");
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
