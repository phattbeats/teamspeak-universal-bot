//! Length-prefixed frame codec shared by the Sexton's Unix-socket server and
//! the ts-bridge client.
//!
//! Wire format (one frame per `tokio::io::AsyncWriteExt::write_all` call —
//! the underlying stream is framed, so messages are atomic at the
//! `write_all` boundary even though they cross a Unix-domain socket rather
//! than a TCP connection):
//!
//! ```text
//! +--------+-------------------+--------------------+
//! | 1 byte | 4 bytes LE u32    | N bytes (JSON)     |
//! |  type  | header_bytes.len  | serde_json::Value  |
//! +--------+-------------------+--------------------+
//! ```
//!
//! Each frame carries a JSON header and a payload of arbitrary bytes (the
//! payload is opaque to this crate — the bridge uses it for raw PCM
//! samples; the Sexton never carries payloads itself). The codec does not
//! enforce that the header or payload are well-formed beyond the length
//! prefix — the consumer decodes them by `msg_type`.

use serde::Serialize;

/// 1-byte frame type. The wire contract: the Sexton reserves the low
/// nibble for `BridgeEvent`s and the high nibble for inbound
/// `BridgeCommand`s, mirroring the WebSocket frame layout in
/// `ts-bridge/src/protocol.rs`. New types MUST be added here so the
/// consumer never reads an unknown byte as data.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameType {
    // --- BridgeEvent (server -> bridge) ---
    SpeakerAudio = 0x01,
    SpeakerStart = 0x02,
    SpeakerStop = 0x03,
    Roster = 0x04,
    TextMessage = 0x05,
    State = 0x06,

    // --- BridgeCommand (bridge -> server) ---
    VoiceAudio = 0x81,
    MusicAudio = 0x82,
    MusicGain = 0x83,
    ClearVoice = 0x84,
    SayText = 0x85,
    Join = 0x86,
    Mute = 0x87,
    Poke = 0x88,
    SendText = 0x89,

    /// Hello / HelloAck (handshake, see `handshake.rs`).
    Hello = 0xF0,
    HelloAck = 0xF1,
}

impl FrameType {
    pub fn from_byte(b: u8) -> Option<Self> {
        Some(match b {
            0x01 => Self::SpeakerAudio,
            0x02 => Self::SpeakerStart,
            0x03 => Self::SpeakerStop,
            0x04 => Self::Roster,
            0x05 => Self::TextMessage,
            0x06 => Self::State,
            0x81 => Self::VoiceAudio,
            0x82 => Self::MusicAudio,
            0x83 => Self::MusicGain,
            0x84 => Self::ClearVoice,
            0x85 => Self::SayText,
            0x86 => Self::Join,
            0x87 => Self::Mute,
            0x88 => Self::Poke,
            0x89 => Self::SendText,
            0xF0 => Self::Hello,
            0xF1 => Self::HelloAck,
            _ => return None,
        })
    }
}

/// A decoded inbound frame, header-parsed but payload left raw. The
/// payload is owned `Vec<u8>` (rather than a slice into the read buffer)
/// because the read buffer is consumed by the next frame — borrowed
/// slices would not survive past the next read.
#[derive(Debug)]
pub struct RawFrame {
    pub msg_type: FrameType,
    pub header: serde_json::Value,
    pub payload: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("frame shorter than the 5-byte prefix")]
    TooShort,
    #[error("unknown frame type byte: {0:#x}")]
    UnknownType(u8),
    #[error("header length {0} exceeds remaining frame bytes")]
    HeaderOverrun(u32),
    #[error("header is not valid JSON: {0}")]
    BadJson(#[from] serde_json::Error),
}

/// Decode one frame from a contiguous byte buffer.
///
/// Returns the frame plus the number of bytes consumed — callers passing
/// a long buffer can slice `&bytes[..consumed]` and keep `&bytes[consumed..]`
/// for the next frame. Returns `FrameError::TooShort` if fewer than 5 bytes
/// are available (callers handle buffering) and `HeaderOverrun` if the
/// length prefix claims more than the buffer holds.
pub fn decode_frame(bytes: &[u8]) -> Result<(RawFrame, usize), FrameError> {
    if bytes.len() < 5 {
        return Err(FrameError::TooShort);
    }
    let msg_type = FrameType::from_byte(bytes[0]).ok_or(FrameError::UnknownType(bytes[0]))?;
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
    Ok((
        RawFrame {
            msg_type,
            header,
            payload,
        },
        header_end + (bytes.len() - header_end),
    ))
}

/// Build a frame from a serializable header and payload bytes. Returns the
/// fully-written buffer; the caller is responsible for the actual
/// `write_all` call (the codec does not own an `AsyncWrite`).
pub fn encode_frame(
    msg_type: FrameType,
    header: &impl Serialize,
    payload: &[u8],
) -> Vec<u8> {
    let header_bytes = serde_json::to_vec(header).unwrap_or_else(|_| b"{}".to_vec());
    let mut out = Vec::with_capacity(5 + header_bytes.len() + payload.len());
    out.push(msg_type as u8);
    out.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_bytes);
    out.extend_from_slice(payload);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serialize;

    #[derive(Serialize)]
    struct EmptyHeader {}

    #[test]
    fn speaker_audio_frame_round_trips() {
        let pcm: Vec<u8> = (0..960u16).flat_map(|i| (i.wrapping_mul(37)).to_le_bytes()).collect();
        let header = serde_json::json!({"clientId": 42, "nickname": "someone", "seq": 7});
        let bytes = encode_frame(FrameType::SpeakerAudio, &header, &pcm);

        let (decoded, consumed) = decode_frame(&bytes).expect("decode");
        assert_eq!(consumed, bytes.len());
        assert_eq!(decoded.msg_type, FrameType::SpeakerAudio);
        assert_eq!(decoded.header["clientId"], 42);
        assert_eq!(decoded.header["nickname"], "someone");
        assert_eq!(decoded.header["seq"], 7);
        assert_eq!(decoded.payload, pcm);
    }

    #[test]
    fn empty_payload_and_empty_header_are_both_legal() {
        let bytes = encode_frame(FrameType::ClearVoice, &EmptyHeader {}, &[]);
        let (decoded, consumed) = decode_frame(&bytes).expect("decode");
        assert_eq!(consumed, bytes.len());
        assert_eq!(decoded.msg_type, FrameType::ClearVoice);
        assert_eq!(decoded.header, serde_json::json!({}));
        assert!(decoded.payload.is_empty());
    }

    #[test]
    fn truncated_and_overrunning_frames_are_rejected_not_panics() {
        // Under 5 bytes → TooShort, never UnknownType.
        assert!(matches!(decode_frame(&[0x01, 0x00]), Err(FrameError::TooShort)));

        // Header claims more bytes than the frame actually carries.
        let mut raw = vec![FrameType::VoiceAudio as u8];
        raw.extend_from_slice(&9_000u32.to_le_bytes());
        raw.extend_from_slice(b"{}");
        assert!(matches!(
            decode_frame(&raw),
            Err(FrameError::HeaderOverrun(9_000))
        ));
    }

    #[test]
    fn unknown_frame_type_is_rejected() {
        let bytes = vec![0xFE, 0x00, 0x00, 0x00, 0x00];
        assert!(matches!(
            decode_frame(&bytes),
            Err(FrameError::UnknownType(0xFE))
        ));
    }
}