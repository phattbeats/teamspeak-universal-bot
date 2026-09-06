# ts-bridge WebSocket protocol

One WebSocket, binary frames only (no text frames). Every frame is:

```
byte 0        : message type (u8)
bytes 1..5    : header length, u32 little-endian (N)
bytes 5..5+N  : header, UTF-8 JSON (N bytes, may be `{}`)
bytes 5+N..   : payload (raw bytes, may be empty)
```

PCM payloads are always mono 48 kHz, signed 16-bit little-endian samples
(`pcm16`). A full frame is 960 samples = 1920 bytes (20 ms); senders may send
shorter chunks and the bridge will buffer/pad, but 960-sample frames are the
native unit on both lanes.

Message types the bridge sends (`out`):

| type | name           | header                                                        | payload            |
|-----:|----------------|----------------------------------------------------------------|--------------------|
| 0x01 | `speaker_audio`| `{"clientId":u16,"nickname":string,"seq":u32}`                  | pcm16, ≤960 samples|
| 0x02 | `speaker_start`| `{"clientId":u16}`                                              | —                  |
| 0x03 | `speaker_stop` | `{"clientId":u16}`                                              | —                  |
| 0x04 | `roster`       | `[{"clientId":u16,"nickname":string,"muted":bool,"away":bool}]` | —                  |
| 0x05 | `text_message` | `{"clientId":u16,"nickname":string,"text":string,"target":"channel"\|"server"\|"client"\|"poke"}` | — |
| 0x06 | `state`        | `{"connected":bool,"channelId":u64,"channelName":string}`       | —                  |

Message types the bridge accepts (`in`):

| type | name          | header                                          | payload              |
|-----:|---------------|--------------------------------------------------|----------------------|
| 0x81 | `voice_audio` | `{}`                                              | pcm16 (model's voice)|
| 0x82 | `music_audio` | `{}`                                              | pcm16 (music lane)   |
| 0x83 | `music_gain`  | `{"gain":f32}` (0..1, multiplies the music lane before ducking) | — |
| 0x84 | `clear_voice` | `{}` (barge-in: drop all queued voice samples)   | —                    |
| 0x85 | `say_text`    | `{"text":string}` (fallback TTS hook; only does anything if `TTS_WEBHOOK_URL` is configured, see README) | — |
| 0x86 | `join`        | `{"channel":string}` (name or numeric id as a string) | —               |
| 0x87 | `mute`        | `{"muted":bool}` (stops/resumes outbound audio; does not touch the TS mute flag) | — |
| 0x88 | `poke`        | `{"clientId":u16,"text":string}`                  | —                    |
| 0x89 | `send_text`   | `{"target":"channel"\|"server"\|u16,"text":string}` (numeric string/number targets a client PM) | — |

No handshake beyond the WebSocket upgrade: on connect the bridge immediately
sends the current `state` and `roster`, in that order, before any live events.
Both are also broadcast whenever they change, so a client that connects while
the bridge is still dialling the server gets `{"connected":false}` and an empty
roster first, then the real ones once the channel is joined. Unknown inbound
message types are logged and ignored, not fatal to the connection.

## Mixer / ducking

Two lanes feed one Opus stream sent to the channel:

- **Voice lane** — from `voice_audio`. Always at full gain.
- **Music lane** — from `music_audio`, scaled by the `music_gain` multiplier
  (default 1.0), then by the duck envelope.

Duck envelope: target gain is `duckGain` (default `0.25`, override via
`DUCK_GAIN` env var) whenever the voice lane has queued samples *or* any
human `speaker_start` is currently active in the channel; otherwise target
is `1.0`. The envelope ramps linearly toward the target, reaching it within
50 ms on the way down (2 × 20 ms frames) and within 800 ms on the way back up
(40 × 20 ms frames), per the spec.

Codec selection per outbound frame: `OpusMusic` @ 64 kbps whenever the music
lane contributed non-silent samples to that frame, `OpusVoice` otherwise
(tsclientlib's default voice bitrate).
