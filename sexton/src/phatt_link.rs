//! PHA-4102: link a TeamSpeak identity to a PHATT ID.
//!
//! The arcade (`src/teamspeak.js` in phattbeats/arcade) hands a signed-in
//! member a short code; the member PMs the bot `!link CODE`; the bot claims
//! it with the sender's TeamSpeak unique id. Once a minute the bot reports
//! everyone connected and gets back who is linked, which drives the one
//! managed "PHATT ID" server group.
//!
//! Everything here is pure (no `Connection`) so it can be unit-tested; the
//! event loop in `main.rs` owns the connection and only applies the results.
//!
//! The outage invariant: a failed, non-200 or unparsable `/online` answer is
//! an `Err` from [`parse_online`], and the caller changes no group on `Err`.
//! An arcade outage must never strip the group from anyone.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;

/// The arcade's code alphabet (`ALPHABET` in arcade `src/teamspeak.js`): no
/// 0/O, 1/I/L.
pub const ALPHABET: &str = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
pub const CODE_LEN: usize = 6;
/// The arcade rejects the whole `/online` batch with 400 past this.
pub const MAX_ONLINE: usize = 1000;
/// Claims per uid per window.
pub const CLAIM_LIMIT: usize = 5;
pub const CLAIM_WINDOW_SECS: i64 = 60;
/// First `/online` this long after connecting (the client-list burst has
/// landed by then), then every `SYNC_EVERY`.
pub const SYNC_FIRST: Duration = Duration::from_secs(15);
pub const SYNC_EVERY: Duration = Duration::from_secs(60);
pub const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
pub const SURFACE: &str = "teamspeak";
pub const DEFAULT_KID: &str = "teamspeak1";

pub const REPLY_BAD_CODE: &str =
    "That code is wrong or expired. Get a new one at https://arcade.phatt.vip/teamspeak";
pub const REPLY_UID_TAKEN: &str =
    "This TeamSpeak identity is already linked to a different PHATT ID. Unlink it there first.";
pub const REPLY_UNREACHABLE: &str = "Couldn't reach the arcade. Try again in a minute.";
pub const REPLY_USAGE: &str =
    "To link your PHATT ID, send: !link CODE (get a code at https://arcade.phatt.vip/teamspeak)";
pub const REPLY_RATE_LIMITED: &str = "Too many tries. Wait a minute and try again.";
pub const REPLY_DISABLED: &str = "PHATT ID linking isn't set up on this bot.";

/// `X-Arcade-Sig`: base64url, no padding, of HMAC-SHA256(secret, "<ts>.<body>")
/// over the exact body bytes sent (arcade `src/auth.js` `sign`).
pub fn sign(secret: &[u8], ts: i64, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC takes a key of any length");
    mac.update(ts.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

/// True for anything that starts with the `!link` command word, valid code or
/// not. Those PMs are always consumed by the link handler so a code (or a
/// mistyped one) never reaches the LLM, the bridge or the chat log.
pub fn is_link_command(text: &str) -> bool {
    let t = text.trim_start();
    let Some(head) = t.get(..5) else { return false };
    if !head.eq_ignore_ascii_case("!link") {
        return false;
    }
    t[5..].chars().next().map_or(true, char::is_whitespace)
}

/// `!link K7Q2XM` (any case; spaces and dashes inside the code tolerated) ->
/// `Some("K7Q2XM")`. Anything else -> `None`.
pub fn parse_link_command(text: &str) -> Option<String> {
    if !is_link_command(text) {
        return None;
    }
    let rest = &text.trim_start()[5..];
    let mut code = String::with_capacity(CODE_LEN);
    for c in rest.chars() {
        if c.is_whitespace() || c == '-' {
            continue;
        }
        let u = c.to_ascii_uppercase();
        if !ALPHABET.contains(u) || code.len() == CODE_LEN {
            return None;
        }
        code.push(u);
    }
    (code.len() == CODE_LEN).then_some(code)
}

/// The arcade's uid check (`UID` in `src/teamspeak.js`). One bad uid fails the
/// whole `/online` batch with 400, so anything else is left out of it.
pub fn valid_uid(uid: &str) -> bool {
    (20..=64).contains(&uid.len()) && uid.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
}

/// Config, read once at startup. Enabled only when both the URL and the
/// secret are set; the secret only ever comes from `ARCADE_SURFACE_SECRET`.
#[derive(Clone)]
pub struct Config {
    pub arcade_url: String,
    pub kid: String,
    pub server_group: Option<u64>,
    /// PHA-5136: the VIP server group, kept in step with the `vip` flag the
    /// arcade puts on each linked entry (a paid club member). None = off.
    pub vip_group: Option<u64>,
    secret: String,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("arcade_url", &self.arcade_url)
            .field("kid", &self.kid)
            .field("server_group", &self.server_group)
            .field("vip_group", &self.vip_group)
            .field("secret", &"<redacted>")
            .finish()
    }
}

impl Config {
    /// `Ok(None)` = linking off. `Err` = set but malformed (a group id that is
    /// not a number): the caller logs it and runs with linking off.
    pub fn resolve(arcade_url: &str, kid: &str, server_group: &str, secret: Option<&str>) -> Result<Option<Self>> {
        let url = arcade_url.trim().trim_end_matches('/');
        let secret = secret.map(str::trim).unwrap_or("");
        if url.is_empty() || secret.is_empty() {
            return Ok(None);
        }
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            bail!("ARCADE_URL must be an http(s) URL");
        }
        let server_group = parse_group(server_group, "PHATT_ID_SERVER_GROUP")?;
        let kid = match kid.trim() {
            "" => DEFAULT_KID.to_string(),
            k => k.to_string(),
        };
        Ok(Some(Self { arcade_url: url.to_string(), kid, server_group, vip_group: None, secret: secret.to_string() }))
    }

    /// PHA-5136: turn on the VIP group (`PHATT_ID_VIP_GROUP`). Empty = off.
    pub fn with_vip_group(mut self, vip_group: &str) -> Result<Self> {
        self.vip_group = parse_group(vip_group, "PHATT_ID_VIP_GROUP")?;
        Ok(self)
    }
}

fn parse_group(g: &str, name: &str) -> Result<Option<u64>> {
    match g.trim() {
        "" => Ok(None),
        g => Ok(Some(g.parse::<u64>().map_err(|_| anyhow!("{name} must be a numeric server group id"))?)),
    }
}

/// An `/online` answer: the linked uids, and (PHA-5136) the VIP ones among
/// them. `vip` is `Some` only when every entry carried a boolean `vip` (or the
/// list is empty, so nobody can be VIP); otherwise the arcade could not say
/// (hub not set up or down) and the VIP group is left as it is.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Linked {
    pub uids: HashSet<String>,
    pub vip: Option<HashSet<String>>,
}

/// What a claim came back as. Logged by label only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimOutcome {
    Linked { display_name: String },
    BadCode,
    UidTaken,
    Failed,
}

impl ClaimOutcome {
    pub fn label(&self) -> &'static str {
        match self {
            ClaimOutcome::Linked { .. } => "linked",
            ClaimOutcome::BadCode => "bad_code",
            ClaimOutcome::UidTaken => "uid_taken",
            ClaimOutcome::Failed => "failed",
        }
    }

    pub fn reply(&self) -> String {
        match self {
            ClaimOutcome::Linked { display_name } if !display_name.is_empty() => {
                format!("Linked to PHATT ID {display_name}. You'll get the PHATT ID group within a minute.")
            }
            ClaimOutcome::Linked { .. } => "Linked to your PHATT ID. You'll get the PHATT ID group within a minute.".to_string(),
            ClaimOutcome::BadCode => REPLY_BAD_CODE.to_string(),
            ClaimOutcome::UidTaken => REPLY_UID_TAKEN.to_string(),
            ClaimOutcome::Failed => REPLY_UNREACHABLE.to_string(),
        }
    }
}

pub fn claim_body(code: &str, uid: &str, nickname: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "code": code, "uid": uid, "nickname": nickname })).expect("json")
}

pub fn parse_claim(status: u16, body: &[u8]) -> ClaimOutcome {
    match status {
        200 => {
            let v: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
            let name = v.get("display_name").and_then(|n| n.as_str()).unwrap_or("");
            // Keep the reply to one plain line whatever the arcade stored.
            let name: String = name.chars().filter(|c| !c.is_control()).take(64).collect();
            ClaimOutcome::Linked { display_name: name.trim().to_string() }
        }
        404 => ClaimOutcome::BadCode,
        409 => ClaimOutcome::UidTaken,
        _ => ClaimOutcome::Failed,
    }
}

/// One connected client as `/online` sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnlineClient {
    pub uid: String,
    pub channel_id: u64,
}

/// The `/online` body plus the set of uids it actually covers (deduped,
/// invalid uids dropped, capped at `MAX_ONLINE`). Only clients whose uid is in
/// that set may have their group touched by the answer.
pub fn online_body(clients: &[OnlineClient]) -> (Vec<u8>, HashSet<String>) {
    let mut seen = HashSet::new();
    let mut list = Vec::new();
    for c in clients {
        if list.len() == MAX_ONLINE {
            break;
        }
        if valid_uid(&c.uid) && seen.insert(c.uid.clone()) {
            list.push(serde_json::json!({ "uid": c.uid, "channel_id": c.channel_id }));
        }
    }
    let body = serde_json::to_vec(&serde_json::json!({ "clients": list })).expect("json");
    (body, seen)
}

/// The linked uids from an `/online` answer. `Err` on anything but a 200 whose
/// body is `{"linked":[{"uid":"..."}, ...]}`: the caller then changes nothing.
pub fn parse_online(status: u16, body: &[u8]) -> Result<Linked> {
    if status != 200 {
        bail!("arcade /online answered {status}");
    }
    let v: serde_json::Value = serde_json::from_slice(body).context("arcade /online: body is not JSON")?;
    let arr = v
        .get("linked")
        .and_then(|l| l.as_array())
        .ok_or_else(|| anyhow!("arcade /online: no `linked` array"))?;
    let mut out = HashSet::with_capacity(arr.len());
    let mut vip = Some(HashSet::new());
    for e in arr {
        let uid = e
            .get("uid")
            .and_then(|u| u.as_str())
            .ok_or_else(|| anyhow!("arcade /online: a `linked` entry has no uid"))?;
        out.insert(uid.to_string());
        match e.get("vip").and_then(|v| v.as_bool()) {
            Some(true) => { if let Some(v) = vip.as_mut() { v.insert(uid.to_string()); } }
            Some(false) => {}
            None => vip = None,
        }
    }
    Ok(Linked { uids: out, vip })
}

/// One connected client as the group reconcile sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupClient {
    pub client_id: u16,
    pub client_db_id: u64,
    pub uid: String,
    pub server_groups: Vec<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupChange {
    Add,
    Remove,
}

/// Add the managed group to linked clients missing it, remove it from
/// unlinked clients that have it. Only `group` is ever touched, and only
/// clients whose uid was in the `/online` request (`queried`) are considered:
/// someone who connected after the request went out is left for the next run.
/// Group membership is per database id, so one change per database id even
/// when an identity is connected twice.
pub fn reconcile(
    clients: &[GroupClient],
    queried: &HashSet<String>,
    linked: &HashSet<String>,
    group: u64,
) -> Vec<(GroupClient, GroupChange)> {
    let mut done = HashSet::new();
    let mut out = Vec::new();
    for c in clients {
        if !queried.contains(&c.uid) || !done.insert(c.client_db_id) {
            continue;
        }
        let has = c.server_groups.contains(&group);
        let want = linked.contains(&c.uid);
        match (want, has) {
            (true, false) => out.push((c.clone(), GroupChange::Add)),
            (false, true) => out.push((c.clone(), GroupChange::Remove)),
            _ => {}
        }
    }
    out
}

/// Sliding-window limiter for `!link` per uid.
#[derive(Default)]
pub struct RateLimit {
    hits: HashMap<String, VecDeque<i64>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Rate {
    Allowed,
    /// The first refusal in a window: worth one "slow down" reply.
    Limited,
    /// Still refused: say nothing, so a spammer cannot make the bot flood.
    Silent,
}

impl RateLimit {
    pub fn check(&mut self, uid: &str, now: i64) -> Rate {
        self.hits.retain(|_, q| q.back().is_some_and(|&t| now - t < CLAIM_WINDOW_SECS));
        let q = self.hits.entry(uid.to_string()).or_default();
        while q.front().is_some_and(|&t| now - t >= CLAIM_WINDOW_SECS) {
            q.pop_front();
        }
        let n = q.len();
        q.push_back(now);
        if n < CLAIM_LIMIT {
            Rate::Allowed
        } else if n == CLAIM_LIMIT {
            Rate::Limited
        } else {
            q.pop_back(); // refused tries do not extend the window
            Rate::Silent
        }
    }
}

/// The arcade HTTP client: signed POSTs over rustls, 10 s timeouts.
pub struct Arcade {
    cfg: Config,
    http: reqwest::Client,
}

impl Arcade {
    pub fn new(cfg: Config) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .connect_timeout(Duration::from_secs(5))
            .user_agent(concat!("sexton/", env!("CARGO_PKG_VERSION"), " (PHATT ID link)"))
            .build()
            .context("building the arcade HTTP client")?;
        Ok(Self { cfg, http })
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }

    /// `(status, body)`; `Err` only for transport failures.
    async fn post(&self, path: &str, body: Vec<u8>) -> Result<(u16, Vec<u8>)> {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let sig = sign(self.cfg.secret.as_bytes(), ts, &body);
        let resp = self
            .http
            .post(format!("{}{path}", self.cfg.arcade_url))
            .header("content-type", "application/json")
            .header("x-arcade-surface", SURFACE)
            .header("x-arcade-kid", &self.cfg.kid)
            .header("x-arcade-ts", ts.to_string())
            .header("x-arcade-sig", sig)
            .body(body)
            .send()
            .await
            .with_context(|| format!("POST {path}"))?;
        let status = resp.status().as_u16();
        let bytes = resp.bytes().await.with_context(|| format!("reading POST {path} answer"))?;
        Ok((status, bytes.to_vec()))
    }

    pub async fn claim(&self, code: &str, uid: &str, nickname: &str) -> ClaimOutcome {
        match self.post("/api/teamspeak/claim", claim_body(code, uid, nickname)).await {
            Ok((status, body)) => parse_claim(status, &body),
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "phatt link: claim request failed");
                ClaimOutcome::Failed
            }
        }
    }

    pub async fn online(&self, body: Vec<u8>) -> Result<Linked> {
        let (status, body) = self.post("/api/teamspeak/online", body).await?;
        parse_online(status, &body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_matches_the_arcade() {
        // node -e "console.log(require('crypto').createHmac('sha256','s3cret')
        //   .update('1700000000.{\"a\":1}').digest('base64url'))"
        assert_eq!(sign(b"s3cret", 1_700_000_000, br#"{"a":1}"#), "FpilC8dNH_HbhcTgpSl8Ktn9uiRdVzfNt4nkzG4JiUA");
        assert_eq!(sign(b"s3cret", 1_700_000_000, b""), "IZSBAPHXqJ8zOPaxEG_E96cC--FJO4M6M4L4AZO94_4");
    }

    #[test]
    fn link_command_parsing() {
        assert_eq!(parse_link_command("!link K7Q2XM").as_deref(), Some("K7Q2XM"));
        assert_eq!(parse_link_command("  !LINK k7q2xm  ").as_deref(), Some("K7Q2XM"));
        assert_eq!(parse_link_command("!Link K7Q-2XM").as_deref(), Some("K7Q2XM"));
        assert_eq!(parse_link_command("!link k7q 2xm").as_deref(), Some("K7Q2XM"));
        assert_eq!(parse_link_command("!link\tK7Q2XM").as_deref(), Some("K7Q2XM"));
        // Not in the alphabet (0, O, 1, I, L), wrong length, junk.
        for bad in ["!link K7Q2X0", "!link K7Q2XO", "!link K7Q2X1", "!link K7Q2XI", "!link K7Q2XL", "!link K7Q2X",
            "!link K7Q2XMM", "!link", "!link ", "!linkK7Q2XM", "link K7Q2XM", "hi !link K7Q2XM", "!link K7Q2X!",
            "!link K7Q2XM extra", "!lınk K7Q2XM", ""]
        {
            assert_eq!(parse_link_command(bad), None, "{bad:?}");
        }
        assert!(is_link_command("!link"));
        assert!(is_link_command("!LINK nonsense"));
        assert!(!is_link_command("!linked it"));
        assert!(!is_link_command("hello"));
        assert!(!is_link_command("!lin"));
    }

    #[test]
    fn config_needs_url_and_secret() {
        assert!(Config::resolve("", "", "", Some("s")).unwrap().is_none());
        assert!(Config::resolve("https://arcade.phatt.vip", "", "", None).unwrap().is_none());
        assert!(Config::resolve("https://arcade.phatt.vip", "", "", Some("  ")).unwrap().is_none());
        let c = Config::resolve("https://arcade.phatt.vip/", "", "", Some("s")).unwrap().unwrap();
        assert_eq!((c.arcade_url.as_str(), c.kid.as_str(), c.server_group), ("https://arcade.phatt.vip", DEFAULT_KID, None));
        let c = Config::resolve("https://a.example", "k2", " 42 ", Some("s")).unwrap().unwrap();
        assert_eq!((c.kid.as_str(), c.server_group), ("k2", Some(42)));
        assert!(Config::resolve("https://a.example", "", "PHATT", Some("s")).is_err());
        assert!(Config::resolve("arcade.phatt.vip", "", "", Some("s")).is_err());
        assert!(!format!("{c:?}").contains("\"s\""), "secret must not be in Debug");
    }

    #[test]
    fn claim_answers_map_to_the_replies() {
        let ok = parse_claim(200, br#"{"arcade_id":"x","display_name":"Brandon"}"#);
        assert_eq!(ok.reply(), "Linked to PHATT ID Brandon. You'll get the PHATT ID group within a minute.");
        assert_eq!(parse_claim(404, br#"{"error":"bad_code"}"#).reply(), REPLY_BAD_CODE);
        assert_eq!(parse_claim(409, br#"{"error":"uid_taken"}"#).reply(), REPLY_UID_TAKEN);
        for s in [400, 401, 403, 500, 502] {
            assert_eq!(parse_claim(s, b"").reply(), REPLY_UNREACHABLE);
        }
        assert_eq!(parse_claim(200, b"<html>").label(), "linked");
        assert_eq!(parse_claim(200, br#"{"display_name":"a\nb"}"#), ClaimOutcome::Linked { display_name: "ab".into() });
        let b: serde_json::Value = serde_json::from_slice(&claim_body("K7Q2XM", "u", "n")).unwrap();
        assert_eq!(b, serde_json::json!({"code":"K7Q2XM","uid":"u","nickname":"n"}));
    }

    const U1: &str = "uA0U7t4PBxdJ5TLnarsOHQh4/tY=";
    const U2: &str = "b+P0CqXms5I0C+A66HZ4Sbu/PNw=";
    const U3: &str = "lks7QL5OVMKo4pZ79cEOI5r5oEA=";

    #[test]
    fn online_body_dedupes_and_drops_what_the_arcade_would_400_on() {
        let c = |uid: &str, ch| OnlineClient { uid: uid.into(), channel_id: ch };
        let (body, queried) = online_body(&[c(U1, 1), c(U1, 2), c("serveradmin", 3), c(U2, 4)]);
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v, serde_json::json!({"clients":[{"uid":U1,"channel_id":1},{"uid":U2,"channel_id":4}]}));
        assert_eq!(queried, HashSet::from([U1.to_string(), U2.to_string()]));
        let many: Vec<OnlineClient> = (0..1500).map(|i| c(&format!("{i:0>28}"), 1)).collect();
        assert_eq!(online_body(&many).1.len(), MAX_ONLINE);
    }

    #[test]
    fn online_failures_are_errors_never_an_empty_set() {
        assert_eq!(
            parse_online(200, format!(r#"{{"linked":[{{"uid":"{U1}","arcade_id":"a","display_name":"d"}}]}}"#).as_bytes()).unwrap().uids,
            HashSet::from([U1.to_string()])
        );
        assert!(parse_online(200, br#"{"linked":[]}"#).unwrap().uids.is_empty());
        for (s, b) in [
            (500, &br#"{"linked":[]}"#[..]),
            (401, br#"{"error":"bad_signature"}"#),
            (502, b"<html>bad gateway</html>"),
            (200, b"<html>cloudflare</html>"),
            (200, b""),
            (200, br#"{}"#),
            (200, br#"{"linked":null}"#),
            (200, br#"{"linked":[{"arcade_id":"a"}]}"#),
        ] {
            assert!(parse_online(s, b).is_err(), "{s} {}", String::from_utf8_lossy(b));
        }
    }

    #[test]
    fn online_vip_only_when_every_entry_says() {
        let l = parse_online(200, format!(r#"{{"linked":[{{"uid":"{U1}","vip":true}},{{"uid":"{U2}","vip":false}}]}}"#).as_bytes()).unwrap();
        assert_eq!(l.uids, HashSet::from([U1.to_string(), U2.to_string()]));
        assert_eq!(l.vip, Some(HashSet::from([U1.to_string()])));
        // one entry without it (the arcade could not ask the hub): VIP unknown, the group is left alone
        let l = parse_online(200, format!(r#"{{"linked":[{{"uid":"{U1}","vip":true}},{{"uid":"{U2}"}}]}}"#).as_bytes()).unwrap();
        assert_eq!(l.vip, None);
        assert_eq!(parse_online(200, format!(r#"{{"linked":[{{"uid":"{U1}","vip":"yes"}}]}}"#).as_bytes()).unwrap().vip, None);
        // nobody linked: nobody is VIP either
        assert_eq!(parse_online(200, br#"{"linked":[]}"#).unwrap().vip, Some(HashSet::new()));
        let c = Config::resolve("https://a.example", "", "10", Some("s")).unwrap().unwrap();
        assert_eq!(c.vip_group, None);
        assert_eq!(c.clone().with_vip_group(" 11 ").unwrap().vip_group, Some(11));
        assert_eq!(c.clone().with_vip_group("").unwrap().vip_group, None);
        assert!(c.with_vip_group("VIP").is_err());
    }

    fn gc(id: u16, db: u64, uid: &str, groups: &[u64]) -> GroupClient {
        GroupClient { client_id: id, client_db_id: db, uid: uid.into(), server_groups: groups.to_vec() }
    }

    #[test]
    fn reconcile_touches_only_the_managed_group() {
        let g = 42;
        let clients = vec![
            gc(1, 10, U1, &[8]),       // linked, missing it -> add
            gc(2, 20, U2, &[8, 42]),   // not linked, has it -> remove
            gc(3, 30, U3, &[8, 42, 9]), // linked, has it -> nothing
        ];
        let queried: HashSet<String> = [U1, U2, U3].iter().map(|s| s.to_string()).collect();
        let linked: HashSet<String> = [U1, U3].iter().map(|s| s.to_string()).collect();
        let out: Vec<(u16, GroupChange)> = reconcile(&clients, &queried, &linked, g).into_iter().map(|(c, ch)| (c.client_id, ch)).collect();
        assert_eq!(out, vec![(1, GroupChange::Add), (2, GroupChange::Remove)]);
        // Other groups are never in play: an unlinked client with only group 9 is left alone.
        assert!(reconcile(&[gc(4, 40, U2, &[9])], &queried, &linked, g).is_empty());
    }

    #[test]
    fn reconcile_skips_unqueried_clients_and_dedupes_db_ids() {
        let queried = HashSet::from([U1.to_string()]);
        let linked = HashSet::from([U1.to_string()]);
        // U2 connected after the request went out: not touched even though it has the group.
        let clients = vec![gc(1, 10, U1, &[]), gc(5, 10, U1, &[]), gc(2, 20, U2, &[42])];
        let out = reconcile(&clients, &queried, &linked, 42);
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].0.client_id, out[0].1), (1, GroupChange::Add));
        // Nobody linked (a real, successful answer): everyone queried who has it loses it.
        let out = reconcile(&[gc(2, 20, U2, &[42])], &HashSet::from([U2.to_string()]), &HashSet::new(), 42);
        assert_eq!(out[0].1, GroupChange::Remove);
    }

    #[test]
    fn rate_limit_per_uid() {
        let mut r = RateLimit::default();
        for _ in 0..CLAIM_LIMIT {
            assert_eq!(r.check("a", 100), Rate::Allowed);
        }
        assert_eq!(r.check("a", 101), Rate::Limited);
        assert_eq!(r.check("a", 102), Rate::Silent);
        assert_eq!(r.check("b", 102), Rate::Allowed);
        assert_eq!(r.check("a", 100 + CLAIM_WINDOW_SECS), Rate::Allowed);
    }
}
