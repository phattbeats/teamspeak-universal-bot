//! Bridge events, commands, and the roster/state shape shared by Sexton and
//! ts-bridge.
//!
//! These types are the *internal* IPC. They mirror the public WebSocket
//! protocol in `ts-bridge/src/protocol.rs` 1:1 so the bridge can fan out
//! `BridgeEvent` -> WebSocket frame and `WebSocket frame` -> `BridgeCommand`
//! without re-encoding.
//!
//! The bridge's `Mixer`, `protocol.rs` codec, and `ws_server.rs` are
//! unchanged. Only `ts_client.rs` (which used to own the connection) is
//! gone — its responsibilities move to the Sexton's new `--bridge-socket`
//! task, and the bridge gets a thin `bridge_client.rs` that consumes
//! `BridgeEvent`/`BridgeCommand` from the Unix socket.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RosterEntry {
    #[serde(rename = "clientId")]
    pub client_id: u16,
    pub nickname: String,
    pub muted: bool,
    pub away: bool,
    /// Names of the server groups this client belongs to (PHA-3786). Empty
    /// by default so old callers that construct a `RosterEntry` without it
    /// (tests, mostly) keep compiling. The moderation tool gate
    /// (`tools.moderation.allowGroups`) lives on the TS plugin side, not
    /// here — the Sexton just reports group membership on the wire.
    #[serde(rename = "serverGroups", default)]
    pub server_groups: Vec<String>,
}

/// Inbound command from the bridge. The Sexton owns the `tsclientlib`
/// connection; it serializes every command through the same writer (a
/// `Mutex<Connection>` shared with the event-loop task) so two bridges
/// can't issue `OutClientMoveMessage` against each other's state.
#[derive(Debug, Clone, Deserialize)]
pub enum BridgeCommand {
    /// Push PCM samples (voice lane, `CodecType::OpusVoice`). 20 ms mono
    /// frames at 48 kHz, 960 samples each. Payload is the raw i16 LE
    /// samples concatenated; the header carries the count.
    VoiceAudio { samples: Vec<i16> },
    /// Push PCM samples (music lane, `CodecType::OpusMusic`). Same shape as
    /// `VoiceAudio` but encoded at the music bitrate and ducked by the
    /// server-side mixer the moment `SpeakerStart` arrives.
    MusicAudio { samples: Vec<i16> },
    /// Set the music lane's gain (0..1). Default 0.25 (PHA-3174).
    MusicGain { gain: f32 },
    /// Drop whatever the voice lane is mid-sentence. Required so the
    /// Sexton emits a `stop-talking` Opus frame on the connection (the
    /// server-side mixer holds the lane open until it sees one).
    ClearVoice,
    /// TTS hook (PHA-3228). Server POSTs text to a configured URL and
    /// expects raw pcm16 mono 48k samples back; the Sexton injects them
    /// on the voice lane the same way the bridge used to.
    SayText { text: String },
    /// Move the bot into the named or numeric channel.
    Join { channel: String },
    /// Mute / unmute the bot's outgoing voice. `muted=true` flushes any
    /// in-flight stream (the bridge used to do this; the Sexton does it
    /// now since it owns the connection).
    Mute { muted: bool },
    /// Poke a client by `ClientId` with the given text. Used by the
    /// `poke` voice tool.
    Poke { client_id: u16, text: String },
    /// Send a text message. `target` is the JSON shape the bridge's
    /// WebSocket protocol already speaks (`{kind: "channel"}` /
    /// `{kind: "server"}` / `{kind: "client", id: <u16>}`); the Sexton
    /// turns it into a `MessageTarget` on the `Connection`.
    SendText { target: SendTarget, text: String },

    // --- moderation (PHA-3786, TOOL-CATALOG.md §4.3) -----------------------
    // Authorization (server-group allowlist) lives on the TS plugin side,
    // which owns `tools.moderation.allowGroups` config — the Sexton trusts
    // whatever bridge command it's given, same failure model as `Poke` and
    // `SendText` above (the plugin is the bridge's only caller).
    /// Kick a client from their channel (`from_server=false`) or off the
    /// server entirely (`from_server=true`).
    ClientKick { client_id: u16, from_server: bool, reason: Option<String> },
    /// Ban a client. `duration_secs=None` is a permanent ban.
    BanClient { client_id: u16, duration_secs: Option<u64>, reason: Option<String> },
    /// Remove one ban by its `BanId`.
    BanDel { ban_id: u32 },
    /// Ask the server for the current ban list. The response is not parsed
    /// yet (no notify-event listener wired for it) — see
    /// `BridgeEvent::ModerationResult`'s doc comment.
    BanList,
    /// Move another client (not the bot itself — that's `Join`) into a
    /// different channel.
    ClientMove { client_id: u16, channel_id: u64 },
    /// Mute or unmute another client. TeamSpeak's ServerQuery-level API has
    /// no literal "mute someone else" command; this works by granting or
    /// revoking talk power (`talk_power_granted`), which is the same
    /// mechanism TS3AudioBot and other moderation bots use.
    ClientEditMute { client_id: u16, muted: bool },
    /// Edit a channel's name and/or topic.
    ChannelEdit { channel_id: u64, name: Option<String>, topic: Option<String> },
    /// Create a channel, optionally under a parent.
    ChannelCreate { name: String, parent_id: Option<u64> },
    /// Delete a channel. `force=true` deletes it even if clients are still
    /// inside.
    ChannelDelete { channel_id: u64, force: bool },
    /// Edit the virtual server's name and/or welcome message.
    ServerEdit { name: Option<String>, welcome_message: Option<String> },
    /// Add a client to a server group. `client_id` is the runtime
    /// `ClientId`; the Sexton resolves it to the `ClientDbId` the TS3
    /// command actually needs.
    ServerGroupAddClient { server_group_id: u64, client_id: u16 },
    /// Ask for the full channel tree — every channel on the server with
    /// who currently occupies it (PHA-3784: `list_channels`, `where_is`,
    /// and `move_to_channel`'s `follow <nickname>` all need to see
    /// channels other than the Sexton's own). The Sexton answers with a
    /// `BridgeEvent::ChannelTree` pushed back over the same broadcast
    /// channel `Join`/`Poke` results would use if they had any — there is
    /// no request/response correlation because `ws_server::run` only ever
    /// serves the one bridge client a live Sexton has.
    ListChannels,
}

/// One channel and who is sitting in it, as of the last `ListChannels`
/// request (PHA-3784). `channel_id` is the `u64` inside `ChannelId` so it
/// round-trips through `Join { channel: "<id>" }`, which already accepts a
/// numeric channel spec via `audio::resolve_channel_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelInfo {
    #[serde(rename = "channelId")]
    pub channel_id: u64,
    pub name: String,
    pub occupants: Vec<RosterEntry>,
}

/// Where a `SendText` lands. The JSON shape mirrors the bridge's
/// `SendTextHeader` so the WebSocket layer does not need to re-encode.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SendTarget {
    Channel,
    Server,
    Client { id: u16 },
}

/// Outbound event from the Sexton. The bridge subscribes via the Unix
/// socket and forwards each one as a WebSocket frame to its clients.
///
/// All variants carry the data the WebSocket protocol needs *already* —
/// `nickname`, `channel_name`, etc. are looked up by the Sexton's event
/// loop using its in-process `Connection::get_state()`. This is the
/// single place the roster resolution lives; the bridge used to do it
/// itself with a separate `Connection` (now removed).
#[derive(Debug, Clone, Serialize)]
pub enum BridgeEvent {
    SpeakerAudio {
        #[serde(rename = "clientId")]
        client_id: u16,
        nickname: String,
        seq: u32,
        /// 48 kHz mono, pcm16 LE, one 20 ms frame (960 samples).
        pcm: Vec<i16>,
    },
    SpeakerStart {
        #[serde(rename = "clientId")]
        client_id: u16,
    },
    SpeakerStop {
        #[serde(rename = "clientId")]
        client_id: u16,
    },
    Roster(Vec<RosterEntry>),
    TextMessage {
        #[serde(rename = "clientId")]
        client_id: u16,
        nickname: String,
        text: String,
        /// One of `"channel"`, `"server"`, `"client"`, `"poke"` — matches
        /// the bridge's WebSocket protocol exactly (see
        /// `ts-bridge/src/protocol.rs`).
        target: &'static str,
    },
    State(StateSnapshot),
    /// Result of a moderation `BridgeCommand` (PHA-3786). `action` names the
    /// command (e.g. `"client_kick"`), `detail` is a short human-readable
    /// outcome. `BanList` always reports `ok: true` with a `detail` noting
    /// the request was sent but the server's response is not parsed by this
    /// codebase yet — there is no ban-list notify-event listener wired up.
    ModerationResult { action: &'static str, ok: bool, detail: String },
    /// Answer to `BridgeCommand::ListChannels` (PHA-3784).
    ChannelTree(Vec<ChannelInfo>),
}

/// Snapshot of the Sexton's connection state. The bridge keeps one of
/// these in `Arc<Mutex<Snapshot>>` so a WebSocket client that connects
/// between two roster changes still gets the current picture
/// (`PROTOCOL.md`'s on-connect promise).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StateSnapshot {
    pub connected: bool,
    #[serde(rename = "channelId")]
    pub channel_id: u64,
    #[serde(rename = "channelName")]
    pub channel_name: String,
    /// The Sexton's own runtime `ClientId` on the shared connection —
    /// absent while disconnected.
    #[serde(rename = "ownClientId", skip_serializing_if = "Option::is_none")]
    pub own_client_id: Option<u16>,
}

impl StateSnapshot {
    /// Frames a freshly connected WebSocket client is owed, in the order
    /// the live stream would have delivered them: state first, then
    /// roster. Used by both the bridge's WS server and the bridge's
    /// internal replay-on-reconnect.
    pub fn replay_events(&self, roster: &[RosterEntry]) -> Vec<BridgeEvent> {
        vec![BridgeEvent::State(self.clone()), BridgeEvent::Roster(roster.to_vec())]
    }
}

/// The on-disk / in-process snapshot the bridge holds between events.
/// Belt-and-braces over `StateSnapshot`: the bridge also keeps the
/// roster here so it can serve a `who_is_here` voice tool answer
/// without re-asking the Sexton.
#[derive(Debug, Default)]
pub struct Snapshot {
    pub connected: bool,
    pub channel_id: u64,
    pub channel_name: String,
    pub own_client_id: Option<u16>,
    pub roster: Vec<RosterEntry>,
}

impl Snapshot {
    /// Build the WS frame sequence for a newly-connected client:
    /// `State` followed by `Roster`. The bridge's WS server calls this
    /// exactly the same way it called the in-process version.
    pub fn events(&self) -> Vec<BridgeEvent> {
        vec![
            BridgeEvent::State(StateSnapshot {
                connected: self.connected,
                channel_id: self.channel_id,
                channel_name: self.channel_name.clone(),
                own_client_id: self.own_client_id,
            }),
            BridgeEvent::Roster(self.roster.clone()),
        ]
    }

    pub fn apply_state(&mut self, snap: &StateSnapshot) {
        self.connected = snap.connected;
        self.channel_id = snap.channel_id;
        self.channel_name = snap.channel_name.clone();
        self.own_client_id = snap.own_client_id;
    }

    pub fn apply_roster(&mut self, roster: &[RosterEntry]) {
        self.roster = roster.to_vec();
    }

    pub fn set_disconnected(&mut self) {
        self.connected = false;
        self.channel_id = 0;
        self.channel_name.clear();
        self.own_client_id = None;
        self.roster.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_replay_yields_state_then_roster() {
        let s = Snapshot {
            connected: true,
            channel_id: 7,
            channel_name: "General Shit".into(),
            own_client_id: Some(3),
            roster: vec![RosterEntry {
                client_id: 4,
                nickname: "Brandon".into(),
                muted: false,
                away: false,
                server_groups: vec![],
            }],
        };
        let frames = s.events();
        assert!(matches!(frames[0], BridgeEvent::State(_)));
        assert!(matches!(frames[1], BridgeEvent::Roster(_)));
    }

    #[test]
    fn default_snapshot_reports_disconnected() {
        let s = Snapshot::default();
        assert!(!s.connected);
        assert!(s.events()[0].matches_disconnected());
    }

    // Helper trait so we can match the state event by its inner field.
    impl BridgeEvent {
        fn matches_disconnected(&self) -> bool {
            matches!(
                self,
                BridgeEvent::State(s) if !s.connected && s.channel_id == 0 && s.own_client_id.is_none()
            )
        }
    }

    #[test]
    fn send_target_parses_three_kinds() {
        let ch: SendTarget = serde_json::from_value(serde_json::json!({"kind":"channel"})).unwrap();
        assert!(matches!(ch, SendTarget::Channel));
        let cl: SendTarget =
            serde_json::from_value(serde_json::json!({"kind":"client","id":42})).unwrap();
        assert!(matches!(cl, SendTarget::Client { id: 42 }));
        let sv: SendTarget = serde_json::from_value(serde_json::json!({"kind":"server"})).unwrap();
        assert!(matches!(sv, SendTarget::Server));
    }

    #[test]
    fn client_kick_command_parses_with_fields() {
        let cmd: BridgeCommand = serde_json::from_value(serde_json::json!({
            "ClientKick": { "client_id": 7, "from_server": true, "reason": "spamming" }
        }))
        .unwrap();
        match cmd {
            BridgeCommand::ClientKick { client_id, from_server, reason } => {
                assert_eq!(client_id, 7);
                assert!(from_server);
                assert_eq!(reason.as_deref(), Some("spamming"));
            }
            other => panic!("expected ClientKick, got {other:?}"),
        }
    }

    #[test]
    fn ban_list_command_parses_with_no_fields() {
        let cmd: BridgeCommand = serde_json::from_value(serde_json::json!("BanList")).unwrap();
        assert!(matches!(cmd, BridgeCommand::BanList));
    }

    #[test]
    fn moderation_result_event_serializes_action_and_detail() {
        let ev = BridgeEvent::ModerationResult {
            action: "client_kick",
            ok: true,
            detail: "kicked client 7 from channel".into(),
        };
        let json = serde_json::to_value(&ev).unwrap();
        let payload = &json["ModerationResult"];
        assert_eq!(payload["action"], "client_kick");
        assert_eq!(payload["ok"], true);
        assert_eq!(payload["detail"], "kicked client 7 from channel");
    }

    #[test]
    fn roster_entry_defaults_server_groups_when_absent() {
        let entry: RosterEntry = serde_json::from_value(serde_json::json!({
            "clientId": 4,
            "nickname": "Brandon",
            "muted": false,
            "away": false
        }))
        .unwrap();
        assert!(entry.server_groups.is_empty());
    }

    #[test]
    fn list_channels_command_parses_with_no_fields() {
        let cmd: BridgeCommand = serde_json::from_value(serde_json::json!("ListChannels")).unwrap();
        assert!(matches!(cmd, BridgeCommand::ListChannels));
    }

    #[test]
    fn channel_tree_event_serializes_channel_id_and_occupants() {
        let ev = BridgeEvent::ChannelTree(vec![
            ChannelInfo {
                channel_id: 1,
                name: "Lobby".into(),
                occupants: vec![RosterEntry {
                    client_id: 42,
                    nickname: "brandon".into(),
                    muted: false,
                    away: false,
                    server_groups: vec![],
                }],
            },
            ChannelInfo { channel_id: 2, name: "AFK".into(), occupants: vec![] },
        ]);
        let json = serde_json::to_value(&ev).unwrap();
        let channels = &json["ChannelTree"];
        assert_eq!(channels[0]["channelId"], 1);
        assert_eq!(channels[0]["name"], "Lobby");
        assert_eq!(channels[0]["occupants"][0]["nickname"], "brandon");
        assert_eq!(channels[1]["occupants"].as_array().unwrap().len(), 0);
    }
}