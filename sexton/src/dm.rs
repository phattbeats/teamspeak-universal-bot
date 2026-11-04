//! PHA-4917: what the bot says to people in private messages.
//!
//! Pure pieces, no connection: the welcome copy (a persona-pack template built
//! from what the bot can actually do right now), the per-uid refractory period
//! behind the returning-user digest, and the digest itself. `main.rs` owns the
//! wiring (events in, PMs out).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Where the per-uid "last notified" clock lives, next to `.welcomed`.
pub const LASTNOTIFIED_FILE: &str = ".lastnotified";
/// Where the earliest unreported leave per uid lives, so a restart does not
/// forget what a person missed while away.
pub const LASTLEFT_FILE: &str = ".lastleft";

const DEFAULT_TEMPLATE: &str = include_str!("default-welcome.json");

fn truthy(v: &str) -> bool {
    matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes")
}

fn env_bool(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => truthy(&v),
        _ => default,
    }
}

/// The `dm` block of bots.json, as env (`stack.mjs` resolves per-bot over
/// stack-wide and keeps `noWelcome` / `noCatchup` as aliases).
#[derive(Clone, Debug)]
pub struct DmConfig {
    pub welcome: bool,
    pub catchup: bool,
    pub cooldown_secs: i64,
    pub quiet_notice: bool,
    pub include_bots: bool,
    pub max_lines: usize,
    /// The `[BOT]` tag on TS nicks; empty means bots cannot be told apart.
    pub bot_tag: String,
}

impl Default for DmConfig {
    fn default() -> Self {
        Self {
            welcome: true,
            catchup: true,
            cooldown_secs: 240 * 60,
            quiet_notice: false,
            include_bots: true,
            max_lines: 15,
            bot_tag: "[BOT]".to_string(),
        }
    }
}

impl DmConfig {
    pub fn from_env(no_catchup_flag: bool) -> Self {
        let d = Self::default();
        let cooldown_min = std::env::var("SEXTON_DM_COOLDOWN_MIN")
            .ok()
            .and_then(|v| v.trim().parse::<i64>().ok())
            .filter(|m| *m >= 0)
            .unwrap_or(d.cooldown_secs / 60);
        let max_lines = std::env::var("SEXTON_DM_MAX_LINES")
            .ok()
            .and_then(|v| v.trim().parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(d.max_lines);
        Self {
            // The legacy flags win: noWelcome / noCatchup keep working.
            welcome: env_bool("SEXTON_DM_WELCOME", d.welcome) && !env_bool("SEXTON_NO_WELCOME", false),
            catchup: env_bool("SEXTON_DM_CATCHUP", d.catchup) && !no_catchup_flag && !env_bool("SEXTON_NO_CATCHUP", false),
            cooldown_secs: cooldown_min * 60,
            quiet_notice: env_bool("SEXTON_DM_QUIET_NOTICE", d.quiet_notice),
            include_bots: env_bool("SEXTON_DM_INCLUDE_BOTS", d.include_bots),
            max_lines,
            bot_tag: std::env::var("SEXTON_BOT_TAG").unwrap_or(d.bot_tag),
        }
    }
}

/// What the bot can really do right now. Every capability line in the welcome
/// is gated on these, so the copy cannot promise or deny something the config
/// says otherwise (the PHA-3305 rule).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caps {
    /// Voice is live: hearing and speaking both work.
    pub voice: bool,
    pub stream: bool,
    pub music: bool,
    pub catchup: bool,
}

impl Caps {
    /// `voice_mode` is the account's `voice.mode`; the kill-switch file and
    /// `--no-audio` also turn voice off, live (the file is checked each call).
    pub fn resolve(no_audio: bool, voice_mode: &str, voice_off_file: &Path, stream: bool, music: bool, catchup: bool) -> Self {
        let mode_off = voice_mode.trim().eq_ignore_ascii_case("off");
        let voice = !no_audio && !mode_off && !voice_off_file.exists();
        Self { voice, stream, music, catchup }
    }

    fn holds(&self, token: &str) -> bool {
        match token {
            "voice-on" => self.voice,
            "voice-off" => !self.voice,
            "stream" => self.stream,
            "no-stream" => !self.stream,
            "music" => self.music,
            "no-music" => !self.music,
            "catchup" => self.catchup,
            "no-catchup" => !self.catchup,
            // An unknown token never matches: a typo hides a line, it does not
            // make a claim.
            _ => false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct TemplateLine {
    pub text: String,
    /// Every token must hold for the line to be sent.
    #[serde(default)]
    pub when: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct WelcomeTemplate {
    #[serde(default)]
    pub first: Vec<TemplateLine>,
    #[serde(default)]
    pub returning: Vec<TemplateLine>,
}

impl WelcomeTemplate {
    pub fn builtin() -> Self {
        serde_json::from_str(DEFAULT_TEMPLATE).expect("default-welcome.json is valid")
    }

    /// The persona pack's `welcome.json`, else the generic built-in. Fail-open:
    /// a missing or broken file costs the persona's voice, not the welcome.
    pub fn load(path: Option<&Path>) -> Self {
        let Some(path) = path.filter(|p| !p.as_os_str().is_empty()) else { return Self::builtin() };
        match std::fs::read_to_string(path).map(|b| serde_json::from_str::<Self>(&b)) {
            Ok(Ok(t)) => t,
            Ok(Err(e)) => {
                tracing::warn!(error = %e, path = %path.display(), "welcome template is not valid JSON; using the built-in");
                Self::builtin()
            }
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(error = %e, path = %path.display(), "reading the welcome template failed; using the built-in");
                }
                Self::builtin()
            }
        }
    }

    fn render(lines: &[TemplateLine], caps: &Caps, bot: &str, digest: &str) -> String {
        let kept: Vec<String> = lines
            .iter()
            .filter(|l| l.when.iter().all(|t| caps.holds(t)))
            .map(|l| l.text.replace("{bot}", bot).replace("{digest}", digest))
            .collect();
        // Collapse the blank lines gating can leave doubled up or dangling.
        let mut out: Vec<String> = Vec::new();
        for line in kept {
            if line.trim().is_empty() && out.last().map_or(true, |p| p.trim().is_empty()) {
                continue;
            }
            out.push(line);
        }
        while out.last().map_or(false, |l| l.trim().is_empty()) {
            out.pop();
        }
        out.join("\n")
    }

    pub fn first_time(&self, caps: &Caps, bot: &str) -> String {
        Self::render(&self.first, caps, bot, "")
    }

    /// Greeting and digest as one message.
    pub fn returning(&self, caps: &Caps, bot: &str, digest: &str) -> String {
        Self::render(&self.returning, caps, bot, digest.trim_end())
    }
}

/// uid -> epoch seconds, persisted as `uid\tsecs` lines. Used for both the
/// notification clock and the earliest unreported leave.
#[derive(Default, Debug)]
pub struct UidClock {
    map: HashMap<String, i64>,
    path: Option<PathBuf>,
}

impl UidClock {
    pub fn at(path: PathBuf) -> Self {
        Self { map: HashMap::new(), path: Some(path) }
    }

    /// Fail-open: unreadable means empty, which costs at most one extra DM.
    pub fn load(&mut self) {
        let Some(path) = &self.path else { return };
        match std::fs::read_to_string(path) {
            Ok(body) => {
                for line in body.lines() {
                    if let Some((uid, secs)) = line.split_once('\t') {
                        if let (uid, Ok(secs)) = (uid.trim(), secs.trim().parse::<i64>()) {
                            if !uid.is_empty() {
                                self.map.insert(uid.to_string(), secs);
                            }
                        }
                    }
                }
            }
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(error = %e, path = %path.display(), "reading a uid clock failed; treating it as empty");
                }
            }
        }
    }

    pub fn get(&self, uid: &str) -> Option<i64> {
        self.map.get(uid).copied()
    }

    pub fn set(&mut self, uid: &str, secs: i64) {
        self.map.insert(uid.to_string(), secs);
        self.save();
    }

    pub fn remove(&mut self, uid: &str) {
        if self.map.remove(uid).is_some() {
            self.save();
        }
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        let mut entries: Vec<(&String, &i64)> = self.map.iter().collect();
        entries.sort();
        let body: String = entries.iter().map(|(u, s)| format!("{u}\t{s}\n")).collect();
        let write = || -> std::io::Result<()> {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(path, body)
        };
        if let Err(e) = write() {
            tracing::warn!(error = %e, path = %path.display(), "saving a uid clock failed; a restart may repeat a DM");
        }
    }

    /// True when `uid` was last notified inside the window ending at `now`.
    pub fn in_cooldown(&self, uid: &str, now: i64, cooldown_secs: i64) -> bool {
        self.get(uid).map_or(false, |at| now < at + cooldown_secs)
    }
}

/// One line of channel history, as the digest sees it.
pub struct DigestLine<'a> {
    pub ts: i64,
    pub rendered: &'a str,
    pub nickname: &'a str,
}

/// `[start, end)` spans a uid was sitting in the channel.
pub type Spans = Vec<(i64, i64)>;

/// The returning-user digest: lines after `since`, minus anything said while
/// the user was present, minus bot lines when `include_bots` is off. Newest
/// `max_lines` in order, then `+N earlier lines. Ask me for the rest.`
/// `None` when there is nothing to say.
pub fn build_digest(lines: &[DigestLine], since: i64, present: &Spans, cfg: &DmConfig) -> Option<String> {
    let new: Vec<&DigestLine> = lines
        .iter()
        .filter(|l| l.ts > since)
        .filter(|l| !present.iter().any(|(s, e)| l.ts >= *s && l.ts < *e))
        .filter(|l| cfg.include_bots || cfg.bot_tag.is_empty() || !l.nickname.contains(&cfg.bot_tag))
        .collect();
    if new.is_empty() {
        return None;
    }
    let skip = new.len().saturating_sub(cfg.max_lines);
    let mut out = String::new();
    for l in new.iter().skip(skip) {
        out.push_str(l.rendered);
        if !l.rendered.ends_with('\n') {
            out.push('\n');
        }
    }
    if skip > 0 {
        out.push_str(&format!("+{skip} earlier lines. Ask me for the rest.\n"));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(voice: bool, stream: bool) -> Caps {
        Caps { voice, stream, music: true, catchup: true }
    }

    fn sexton() -> WelcomeTemplate {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../personas/sexton/welcome.json");
        WelcomeTemplate::load(Some(&p))
    }

    #[test]
    fn cant_hear_you_is_never_sent_while_voice_is_on() {
        for t in [sexton(), WelcomeTemplate::builtin()] {
            for stream in [true, false] {
                let on = t.first_time(&caps(true, stream), "the Sexton");
                assert!(!on.to_lowercase().contains("can't hear you"), "voice on: {on}");
                assert!(!on.to_lowercase().contains("can't speak"), "voice on: {on}");
                let back = t.returning(&caps(true, stream), "the Sexton", "19:02  Kyle: hi\n");
                assert!(!back.to_lowercase().contains("can't hear you"), "voice on: {back}");
                let off = t.first_time(&caps(false, stream), "the Sexton");
                assert!(off.contains("I can't hear you, and I can't speak"), "voice off: {off}");
            }
        }
    }

    #[test]
    fn stream_line_goes_when_stream_is_not_allowed() {
        let t = sexton();
        assert!(t.first_time(&caps(false, true), "x").contains("Twitch, Kick or YouTube"));
        assert!(!t.first_time(&caps(false, false), "x").contains("Twitch"));
    }

    #[test]
    fn voice_off_file_and_mode_turn_voice_off_live() {
        let dir = std::env::temp_dir().join(format!("sexton-caps-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(".voice-off");
        let _ = std::fs::remove_file(&file);
        assert!(Caps::resolve(false, "stt-tts", &file, true, true, true).voice);
        assert!(!Caps::resolve(false, "off", &file, true, true, true).voice);
        assert!(!Caps::resolve(true, "stt-tts", &file, true, true, true).voice);
        std::fs::write(&file, "x").unwrap();
        assert!(!Caps::resolve(false, "stt-tts", &file, true, true, true).voice);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn first_time_copy_matches_the_spec_when_voice_is_off() {
        let out = sexton().first_time(&caps(false, true), "the Sexton");
        let want = "Welcome in. I'm the Sexton, the bot that keeps this hall.\n\nWorth knowing first: I can't hear you, and I can't speak. Voice chat goes right past me.\n\nWhat I can do:\n• Read what you type, here or in the channel, and answer.\n• Stream a Twitch, Kick or YouTube link for the room, or play music. Just ask.\n• Catch you up when you come back on what was said while you were gone.";
        assert_eq!(out, want);
        assert!(!out.contains("Evening"));
        assert!(!out.to_lowercase().contains("description"));
    }

    #[test]
    fn returning_greeting_and_digest_are_one_message() {
        let out = sexton().returning(&caps(false, true), "x", "19:02  Kyle: hi\n+12 earlier lines. Ask me for the rest.\n");
        assert_eq!(
            out,
            "Welcome back. Still can't hear you or talk back, but type and I'll answer.\n\nWhile you were gone:\n19:02  Kyle: hi\n+12 earlier lines. Ask me for the rest."
        );
    }

    fn cfg() -> DmConfig {
        DmConfig::default()
    }

    fn dl<'a>(ts: i64, nick: &'a str, rendered: &'a str) -> DigestLine<'a> {
        DigestLine { ts, rendered, nickname: nick }
    }

    #[test]
    fn digest_is_none_when_nothing_is_new() {
        let lines = [dl(10, "Kyle", "a\n")];
        assert_eq!(build_digest(&lines, 10, &vec![], &cfg()), None);
        assert_eq!(build_digest(&[], 0, &vec![], &cfg()), None);
    }

    #[test]
    fn digest_includes_bots_and_skips_lines_from_while_present() {
        let lines = [
            dl(5, "Kyle", "old\n"),
            dl(20, "Kyle", "new human\n"),
            dl(30, "Ledger [BOT]", "new bot\n"),
            dl(40, "Kyle", "while present\n"),
        ];
        let out = build_digest(&lines, 10, &vec![(35, 45)], &cfg()).unwrap();
        assert_eq!(out, "new human\nnew bot\n");
        let mut no_bots = cfg();
        no_bots.include_bots = false;
        assert_eq!(build_digest(&lines, 10, &vec![(35, 45)], &no_bots).unwrap(), "new human\n");
    }

    #[test]
    fn digest_shows_newest_lines_and_counts_the_rest() {
        let rendered: Vec<String> = (0..20).map(|i| format!("l{i}\n")).collect();
        let lines: Vec<DigestLine> = rendered.iter().enumerate().map(|(i, r)| dl(i as i64 + 1, "K", r)).collect();
        let out = build_digest(&lines, 0, &vec![], &cfg()).unwrap();
        assert!(out.starts_with("l5\n"));
        assert!(out.contains("l19\n"));
        assert!(out.ends_with("+5 earlier lines. Ask me for the rest.\n"));
    }

    #[test]
    fn cooldown_is_keyed_on_uid_and_survives_a_reload() {
        let dir = std::env::temp_dir().join(format!("sexton-cd-{}", std::process::id()));
        let path = dir.join(LASTNOTIFIED_FILE);
        let _ = std::fs::remove_dir_all(&dir);
        let mut c = UidClock::at(path.clone());
        c.set("uidA=", 1_000);
        let mut again = UidClock::at(path);
        again.load();
        let window = 240 * 60;
        assert!(again.in_cooldown("uidA=", 1_000 + 300, window));
        assert!(again.in_cooldown("uidA=", 1_000 + window - 1, window));
        assert!(!again.in_cooldown("uidA=", 1_000 + window, window));
        assert!(!again.in_cooldown("uidB=", 1_100, window));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unreadable_clock_file_is_empty_not_fatal() {
        let mut c = UidClock::at(PathBuf::from("/nonexistent-dir-for-test/.lastnotified"));
        c.load();
        assert_eq!(c.get("x"), None);
        c.set("x", 1); // save fails quietly
        assert_eq!(c.get("x"), Some(1));
    }
}
