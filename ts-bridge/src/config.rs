use std::net::SocketAddr;

/// Runtime configuration, entirely from the environment so the container
/// needs no baked-in secrets or per-deployment image rebuilds.
pub struct Config {
    /// TS6 host:port, e.g. `teamspeak6-server:9987` (connect by container
    /// name on the `phattvip` Docker network — see PHA-3172 finding #5).
    pub server_address: String,
    /// Nickname the bridge identifies as in the channel.
    pub nickname: String,
    /// Portable TS identity string (`IdentityObj::export` format). Generated
    /// on first launch and persisted by the caller (Paperclip secret) if
    /// `identity` is empty.
    pub identity: Option<String>,
    /// Channel to join on connect: numeric id or exact name.
    pub channel: String,
    /// Optional server password.
    pub password: Option<String>,
    /// Local bind address for the WebSocket server. Only ever bound inside
    /// the compose network — never expose this port publicly.
    pub ws_bind: SocketAddr,
    /// Music lane duck target gain (0..1).
    pub duck_gain: f32,
    /// Optional webhook for the `say_text` fallback TTS hook: POST
    /// `{"text": "..."}`, expects a body of raw pcm16 mono 48k samples back.
    pub tts_webhook_url: Option<String>,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let server_address = std::env::var("TS_SERVER_ADDRESS")
            .unwrap_or_else(|_| "teamspeak6-server:9987".to_string());
        let nickname = std::env::var("TS_NICKNAME").unwrap_or_else(|_| "Sexton-Bridge".to_string());
        let identity = std::env::var("TS_IDENTITY").ok().filter(|s| !s.is_empty());
        let channel = std::env::var("TS_CHANNEL").unwrap_or_else(|_| "0".to_string());
        let password = std::env::var("TS_PASSWORD").ok().filter(|s| !s.is_empty());
        let ws_bind: SocketAddr = std::env::var("WS_BIND")
            .unwrap_or_else(|_| "0.0.0.0:9099".to_string())
            .parse()?;
        let duck_gain: f32 = std::env::var("DUCK_GAIN")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.25);
        let tts_webhook_url = std::env::var("TTS_WEBHOOK_URL").ok().filter(|s| !s.is_empty());

        Ok(Self {
            server_address,
            nickname,
            identity,
            channel,
            password,
            ws_bind,
            duck_gain,
            tts_webhook_url,
        })
    }
}
