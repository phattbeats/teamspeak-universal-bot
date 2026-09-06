//! The Sexton — persistent TeamSpeak channel chat logger (PHA-3099 / PHA-3173).
//!
//! Behaviour (see PHA-3099 for the full spec):
//! 1. Rolling log of the last messages in the channel description (newest at the
//!    bottom, byte budget under the server's 8192-byte hard cap).
//! 2. Catch-up PM to any client that joins/hops into the watched channel
//!    (rate-limited per client).
//! 3. Full markdown log on disk, one file per channel per day.
//!
//! HARD RULE: only real user-authored text messages sent to the watched channel
//! are logged or displayed. Joins, leaves, moves, mutes, aways, kicks, bans,
//! pokes, channel edits, server messages and the bot's own messages are never
//! logged and never touch the description.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use clap::Parser;
use chrono::Local;
use futures::prelude::*;
use md5::{Digest, Md5};
use tracing::{error, info, warn};

use tsclientlib::prelude::*;
use tsclientlib::messages::c2s::{
    OutChannelListRequestMessage, OutClientMoveMessage, OutClientMovePart,
};
use tsclientlib::{
    events::{Event, PropertyId},
    ChannelId, ClientId, Connection, Identity, MessageTarget, StreamItem,
};

/// Channel description hard cap is 8192 bytes (`TS3_MAX_SIZE_CHANNEL_DESCRIPTION`).
/// Stay well under it — PHA-3173 asks for ~7500.
const DESC_BUDGET_BYTES: usize = 7500;
const DESC_HEADER: &str = "— last messages, kept by the Sexton —\n";
/// How many messages the catch-up PM includes.
const CATCHUP_PM_COUNT: usize = 15;
/// One catch-up PM per client per this long.
const PM_RATE_LIMIT: Duration = Duration::from_secs(10 * 60);
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
}

#[derive(Clone, Debug)]
struct LoggedMessage {
    time_label: String, // HH:MM, local time
    nickname: String,
    text: String,
}

struct ChannelState {
    channel_id: ChannelId,
    channel_name: String,
    history: VecDeque<LoggedMessage>,
    last_pm: HashMap<ClientId, tokio::time::Instant>,
    log_dir: PathBuf,
    /// Clients that were already connected when the bot came up — never PM'd
    /// on account of our own connect.
    preexisting: HashSet<ClientId>,
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
            log_dir,
            preexisting,
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

    /// Render the rolling description: header + newest-at-bottom lines that
    /// fit within DESC_BUDGET_BYTES.
    fn render_description(&self) -> String {
        let mut lines: Vec<String> = Vec::new();
        let mut total = DESC_HEADER.len();
        for entry in self.history.iter().rev() {
            let line = format!("{}  {}: {}\n", entry.time_label, entry.nickname, entry.text);
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

    fn catchup_text(&self) -> String {
        if self.history.is_empty() {
            return format!("Nothing logged yet in \"{}\".", self.channel_name);
        }
        let start = self.history.len().saturating_sub(CATCHUP_PM_COUNT);
        let mut out = String::new();
        for entry in self.history.iter().skip(start) {
            out.push_str(&format!("{}  {}: {}\n", entry.time_label, entry.nickname, entry.text));
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
        writeln!(f, "{}  {}: {}", entry.time_label, entry.nickname, entry.text)?;
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

    let mut backoff = BACKOFF_INITIAL;
    let mut first_connect = true;
    loop {
        match run_once(&args, &address, first_connect).await {
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

async fn run_once(args: &Args, address: &str, first_connect: bool) -> Result<()> {
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
        if let Err(e) = set_description(&mut con, channel_id, &state.render_description()) {
            warn!(error = %e, "initial description push failed");
        }
    }

    if !args.on_connected.is_empty() {
        run_on_connected_hook(&args.on_connected);
    }

    loop {
        let item = match con.events().next().await {
            Some(Ok(item)) => item,
            Some(Err(e)) => return Err(anyhow!("event stream error: {e}")),
            None => return Err(anyhow!("event stream ended")),
        };

        match item {
            StreamItem::BookEvents(events) => {
                for ev in events {
                    handle_event(&mut con, &mut state, own_client_id, ev)?;
                }
            }
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
                            match set_avatar_hash(&mut con, &hash) {
                                Ok(()) => info!(hash = %hash, "avatar hash set"),
                                Err(e) => error!(error = %e, "set_avatar_hash failed"),
                            }
                        }
                    } else {
                        pending_avatar = Some((pending_handle, bytes));
                    }
                }
            }
            StreamItem::FiletransferFailed(_, e) => {
                error!(error = %e, "file transfer failed");
            }
            StreamItem::DisconnectedTemporarily(reason) => {
                return Err(anyhow!("temporary disconnect: {reason:?}"));
            }
            _ => {}
        }
    }
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
                Ok(()) => info!(
                    from = %entry.nickname,
                    kept = state.history.len(),
                    desc_bytes = desc.len(),
                    "logged message; description updated"
                ),
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
    let text = state.catchup_text();
    match send_pm(con, client_id, &text) {
        Ok(()) => info!(?client_id, "catch-up PM sent"),
        Err(e) => warn!(error = %e, ?client_id, "catch-up PM failed"),
    }
}

fn set_description(con: &mut Connection, channel_id: ChannelId, description: &str) -> Result<()> {
    let cmd = {
        let state = con.get_state().map_err(|e| anyhow!("get_state: {e}"))?;
        let channel = state
            .channels
            .get(&channel_id)
            .ok_or_else(|| anyhow!("channel {:?} disappeared from tree", channel_id))?;
        channel.edit().set_description(description)
    };
    cmd.send(con).map_err(|e| anyhow!("channeledit: {e}"))
}

fn set_avatar_hash(con: &mut Connection, hash: &str) -> Result<()> {
    let cmd = {
        let state = con.get_state().map_err(|e| anyhow!("get_state: {e}"))?;
        state.client_update().set_avatar_hash(hash)
    };
    cmd.send(con).map_err(|e| anyhow!("clientupdate avatar hash: {e}"))
}

fn send_pm(con: &mut Connection, client_id: ClientId, text: &str) -> Result<()> {
    let cmd = {
        let state = con.get_state().map_err(|e| anyhow!("get_state: {e}"))?;
        let client = state
            .clients
            .get(&client_id)
            .ok_or_else(|| anyhow!("client {:?} not found", client_id))?;
        client.send_textmessage(text)
    };
    cmd.send(con).map_err(|e| anyhow!("send_textmessage: {e}"))
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
