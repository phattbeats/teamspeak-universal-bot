//! WebSocket wire protocol for the Sexton's audio/voice bridge clients.
//!
//! **PHA-3341** moved the *internal* bridge IPC (`BridgeEvent`,
//! `BridgeCommand`, `Snapshot`, the roster/state shapes) into the
//! `bridge-proto` crate so the Sexton (tsclientlib owner) and the then
//! separate `ts-bridge` process could share types without one depending on
//! the other. **PHA-3342** removed the second process — the WS server and
//! the mixer that used to live in `ts-bridge` now run inside this binary,
//! wired directly to the Sexton's own connection event loop (see
//! `audio.rs`) — but the WebSocket frame envelope here is byte-for-byte
//! unchanged: type byte, length-prefixed JSON header, opaque payload. Any
//! external consumer (the realtime-voice runtime, `bridge-test`) dials the
//! same port with the same frames as before; only the container it's
//! talking to changed.
//!
//! `PROTOCOL.md` (the public contract for those consumers) moved from
//! `ts-bridge/PROTOCOL.md` to `sexton/PROTOCOL.md` unchanged. The frame
//! types line up 1:1 with `bridge_proto::events::BridgeEvent` so `ws_server`
//! does not need to re-encode: `0x01 SpeakerAudio` is the same `0x01
//! SpeakerAudio` bridge-proto and the wire protocol both use.

use serde::{Deserialize, Serialize};

pub const TYPE_SPEAKER_AUDIO: u8 = 0x01;
pub const TYPE_SPEAKER_START: u8 = 0x02;
pub const TYPE_SPEAKER_STOP: u8 = 0x03;
pub const TYPE_ROSTER: u8 = 0x04;
pub const TYPE_TEXT_MESSAGE: u8 = 0x05;
pub const TYPE_STATE: u8 = 0x06;
/// PHA-3786: result of a moderation command.
pub const TYPE_MODERATION_RESULT: u8 = 0x07;
/// PHA-3784: answer to `list_channels`.
pub const TYPE_CHANNEL_TREE: u8 = 0x08;

pub const TYPE_VOICE_AUDIO: u8 = 0x81;
pub const TYPE_MUSIC_AUDIO: u8 = 0x82;
pub const TYPE_MUSIC_GAIN: u8 = 0x83;
pub const TYPE_CLEAR_VOICE: u8 = 0x84;
pub const TYPE_SAY_TEXT: u8 = 0x85;
pub const TYPE_JOIN: u8 = 0x86;
pub const TYPE_MUTE: u8 = 0x87;
pub const TYPE_POKE: u8 = 0x88;
pub const TYPE_SEND_TEXT: u8 = 0x89;

// --- moderation (PHA-3786) --------------------------------------------------
pub const TYPE_CLIENT_KICK: u8 = 0x8A;
pub const TYPE_BAN_CLIENT: u8 = 0x8B;
pub const TYPE_BAN_DEL: u8 = 0x8C;
pub const TYPE_BAN_LIST: u8 = 0x8D;
pub const TYPE_CLIENT_MOVE: u8 = 0x8E;
pub const TYPE_CLIENT_EDIT_MUTE: u8 = 0x8F;
pub const TYPE_CHANNEL_EDIT: u8 = 0x90;
pub const TYPE_CHANNEL_CREATE: u8 = 0x91;
pub const TYPE_CHANNEL_DELETE: u8 = 0x92;
pub const TYPE_SERVER_EDIT: u8 = 0x93;
pub const TYPE_SERVER_GROUP_ADD_CLIENT: u8 = 0x94;

/// PHA-3784: ask for the full channel tree (answered with `TYPE_CHANNEL_TREE`).
pub const TYPE_LIST_CHANNELS: u8 = 0x95;

/// PHA-3857: set the bot's own client description (music now-playing).
pub const TYPE_SET_DESCRIPTION: u8 = 0x96;

/// A decoded inbound frame, header-parsed but payload left raw. Same shape
/// as `bridge_proto::RawFrame` — kept separate so the public WS protocol
/// can evolve without touching the internal event/command vocabulary.
pub struct RawFrame {
    pub msg_type: u8,
    pub header: serde_json::Value,
    pub payload: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("frame shorter than the 5-byte prefix")]
    TooShort,
    #[error("header length {0} exceeds remaining frame bytes")]
    HeaderOverrun(u32),
    #[error("header is not valid JSON: {0}")]
    BadJson(#[from] serde_json::Error),
}

pub fn decode_frame(bytes: &[u8]) -> Result<RawFrame, FrameError> {
    if bytes.len() < 5 {
        return Err(FrameError::TooShort);
    }
    let msg_type = bytes[0];
    let header_len = u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
    let header_end = 5usize.saturating_add(header_len as usize);
    if header_end > bytes.len() {
        return Err(FrameError::HeaderOverrun(header_len));
    }
    let header_bytes = &bytes[5..header_end];
    let header: serde_json::Value = if header_bytes.is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_slice(header_bytes)?
    };
    let payload = bytes[header_end..].to_vec();
    Ok(RawFrame {
        msg_type,
        header,
        payload,
    })
}

pub fn encode_frame(msg_type: u8, header: &impl Serialize, payload: &[u8]) -> Vec<u8> {
    let header_bytes = serde_json::to_vec(header).unwrap_or_else(|_| b"{}".to_vec());
    let mut out = Vec::with_capacity(5 + header_bytes.len() + payload.len());
    out.push(msg_type);
    out.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_bytes);
    out.extend_from_slice(payload);
    out
}

// ---------------------------------------------------------------------------
// Outbound headers. `StateSnapshot`/`RosterEntry` live in bridge-proto; the
// WS layer (ws_server.rs) imports them straight from there and builds them
// via `&[]` payloads, so no re-export lives here.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SpeakerAudioHeader {
    #[serde(rename = "clientId")]
    pub client_id: u16,
    pub nickname: String,
    pub seq: u32,
}

#[derive(Serialize)]
pub struct ClientIdHeader {
    #[serde(rename = "clientId")]
    pub client_id: u16,
}

#[derive(Serialize)]
pub struct TextMessageHeader {
    #[serde(rename = "clientId")]
    pub client_id: u16,
    pub nickname: String,
    pub text: String,
    pub target: &'static str,
}

/// PHA-3786: outbound answer to any moderation command.
#[derive(Serialize)]
pub struct ModerationResultHeader {
    pub action: &'static str,
    pub ok: bool,
    pub detail: String,
}

#[derive(Serialize)]
pub struct StateHeader {
    pub connected: bool,
    #[serde(rename = "channelId")]
    pub channel_id: u64,
    #[serde(rename = "channelName")]
    pub channel_name: String,
    #[serde(rename = "ownClientId", skip_serializing_if = "Option::is_none")]
    pub own_client_id: Option<u16>,
}

// ---------------------------------------------------------------------------
// Inbound headers (commands from WS clients, applied directly to the
// in-process Mixer / tsclientlib Connection — see `audio.rs`).
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct MusicGainHeader {
    pub gain: f32,
}

#[derive(Deserialize)]
pub struct SayTextHeader {
    pub text: String,
}

#[derive(Deserialize)]
pub struct JoinHeader {
    pub channel: String,
}

#[derive(Deserialize)]
pub struct MuteHeader {
    pub muted: bool,
}

#[derive(Deserialize)]
pub struct PokeHeader {
    #[serde(rename = "clientId")]
    pub client_id: u16,
    pub text: String,
}

#[derive(Deserialize)]
pub struct SendTextHeader {
    pub target: serde_json::Value,
    pub text: String,
}

// --- moderation (PHA-3786) --------------------------------------------------

#[derive(Deserialize)]
pub struct ClientKickHeader {
    #[serde(rename = "clientId")]
    pub client_id: u16,
    #[serde(rename = "fromServer")]
    pub from_server: bool,
    pub reason: Option<String>,
}

#[derive(Deserialize)]
pub struct BanClientHeader {
    #[serde(rename = "clientId")]
    pub client_id: u16,
    #[serde(rename = "durationSecs")]
    pub duration_secs: Option<u64>,
    pub reason: Option<String>,
}

#[derive(Deserialize)]
pub struct BanDelHeader {
    #[serde(rename = "banId")]
    pub ban_id: u32,
}

#[derive(Deserialize)]
pub struct ClientMoveHeader {
    #[serde(rename = "clientId")]
    pub client_id: u16,
    #[serde(rename = "channelId")]
    pub channel_id: u64,
}

#[derive(Deserialize)]
pub struct ClientEditMuteHeader {
    #[serde(rename = "clientId")]
    pub client_id: u16,
    pub muted: bool,
}

#[derive(Deserialize)]
pub struct ChannelEditHeader {
    #[serde(rename = "channelId")]
    pub channel_id: u64,
    pub name: Option<String>,
    pub topic: Option<String>,
}

#[derive(Deserialize)]
pub struct ChannelCreateHeader {
    pub name: String,
    #[serde(rename = "parentId")]
    pub parent_id: Option<u64>,
}

#[derive(Deserialize)]
pub struct ChannelDeleteHeader {
    #[serde(rename = "channelId")]
    pub channel_id: u64,
    pub force: bool,
}

#[derive(Deserialize)]
pub struct ServerEditHeader {
    pub name: Option<String>,
    #[serde(rename = "welcomeMessage")]
    pub welcome_message: Option<String>,
}

#[derive(Deserialize)]
pub struct ServerGroupAddClientHeader {
    #[serde(rename = "serverGroupId")]
    pub server_group_id: u64,
    #[serde(rename = "clientId")]
    pub client_id: u16,
}

/// PHA-3857: `set_description` — the bot's own description; `""` clears it.
#[derive(Deserialize)]
pub struct SetDescriptionHeader {
    pub description: String,
}

/// PCM16LE payload bytes -> i16 samples.
pub fn pcm16_to_samples(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect()
}

/// i16 samples -> PCM16LE payload bytes.
pub fn samples_to_pcm16(samples: &[i16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speaker_audio_frame_round_trips() {
        let pcm: Vec<i16> = (0..960).map(|i| (i as i16).wrapping_mul(37)).collect();
        let header = SpeakerAudioHeader {
            client_id: 42,
            nickname: "someone".to_string(),
            seq: 7,
        };
        let bytes = encode_frame(TYPE_SPEAKER_AUDIO, &header, &samples_to_pcm16(&pcm));

        let decoded = decode_frame(&bytes).expect("decode");
        assert_eq!(decoded.msg_type, TYPE_SPEAKER_AUDIO);
        assert_eq!(decoded.header["clientId"], 42);
        assert_eq!(decoded.header["nickname"], "someone");
        assert_eq!(decoded.header["seq"], 7);
        assert_eq!(pcm16_to_samples(&decoded.payload), pcm);
    }

    #[test]
    fn empty_payload_and_empty_header_are_both_legal() {
        let bytes = encode_frame(TYPE_CLEAR_VOICE, &serde_json::json!({}), &[]);
        let decoded = decode_frame(&bytes).expect("decode");
        assert_eq!(decoded.msg_type, TYPE_CLEAR_VOICE);
        assert_eq!(decoded.header, serde_json::json!({}));
        assert!(decoded.payload.is_empty());
    }

    #[test]
    fn truncated_and_overrunning_frames_are_rejected_not_panics() {
        assert!(matches!(decode_frame(&[0x01, 0x00]), Err(FrameError::TooShort)));

        let mut raw = vec![TYPE_VOICE_AUDIO];
        raw.extend_from_slice(&9_000u32.to_le_bytes());
        raw.extend_from_slice(b"{}");
        assert!(matches!(decode_frame(&raw), Err(FrameError::HeaderOverrun(9_000))));
    }

    #[test]
    fn odd_length_pcm_payload_drops_the_trailing_byte_instead_of_panicking() {
        assert_eq!(pcm16_to_samples(&[0x01, 0x00, 0x7f]), vec![1i16]);
    }
}
