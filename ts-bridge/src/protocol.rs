//! WebSocket wire protocol for ts-bridge clients.
//!
//! **PHA-3341 split.** The *internal* bridge IPC (`BridgeEvent`,
//! `BridgeCommand`, `Snapshot`, the roster/state shapes) moved to the
//! `bridge-proto` crate so the Sexton (which now owns the
//! `tsclientlib::Connection`) and the bridge can share types without one
//! depending on the other. What stayed here is the WebSocket frame
//! envelope: type byte, length-prefixed JSON header, opaque payload — and
//! the inbound header shapes the WS server decodes from client commands.
//!
//! `PROTOCOL.md` (the public contract for channel-plugin and voice-tool
//! consumers) is unchanged. The frame types line up 1:1 with the bridge
//! events so the WS server does not need to re-encode: `0x01 SpeakerAudio`
//! is the same `0x01 SpeakerAudio` on both sides of the Unix socket.

use serde::{Deserialize, Serialize};

pub const TYPE_SPEAKER_AUDIO: u8 = 0x01;
pub const TYPE_SPEAKER_START: u8 = 0x02;
pub const TYPE_SPEAKER_STOP: u8 = 0x03;
pub const TYPE_ROSTER: u8 = 0x04;
pub const TYPE_TEXT_MESSAGE: u8 = 0x05;
pub const TYPE_STATE: u8 = 0x06;

pub const TYPE_VOICE_AUDIO: u8 = 0x81;
pub const TYPE_MUSIC_AUDIO: u8 = 0x82;
pub const TYPE_MUSIC_GAIN: u8 = 0x83;
pub const TYPE_CLEAR_VOICE: u8 = 0x84;
pub const TYPE_SAY_TEXT: u8 = 0x85;
pub const TYPE_JOIN: u8 = 0x86;
pub const TYPE_MUTE: u8 = 0x87;
pub const TYPE_POKE: u8 = 0x88;
pub const TYPE_SEND_TEXT: u8 = 0x89;

/// A decoded inbound frame, header-parsed but payload left raw. Same
/// shape as `bridge_proto::RawFrame` — kept separate so the public WS
/// protocol can evolve without touching the internal IPC.
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
// Outbound headers — re-export the bridge-proto types so the WS server
// doesn't have to convert between equivalent shapes. `StateSnapshot`
// lives in both places; this is the seam. (RosterEntry the WS layer builds
// directly from the bridge-proto type via `&[]` payloads, no re-export.)
// ---------------------------------------------------------------------------

pub use bridge_proto::StateSnapshot;

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
// Inbound headers (commands from WS clients to the bridge, forwarded on
// to the Sexton over the Unix socket).
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

#[derive(Deserialize)]
pub struct VoiceAudioHeader {
    pub count: usize,
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