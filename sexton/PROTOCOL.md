# Sexton audio/voice bridge WebSocket protocol

**PHA-3342**: this used to be `ts-bridge/PROTOCOL.md`, served by a separate
`plnt-ts-bridge` container. That container is gone — Brandon's ask was one
docker container, one bot account (PHA-3341/PHA-3342) — and this WebSocket
server now runs inside the Sexton binary itself, on the same port. Nothing
below changed for an external consumer: same frames, same port, same
behaviour. Only the host process did.

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
| 0x06 | `state`        | `{"connected":bool,"channelId":u64,"channelName":string,"ownClientId":u16?}` | —      |
| 0x07 | `moderation_result` | `{"action":string,"ok":bool,"detail":string}` (PHA-3786, answer to every moderation command below) | — |

`roster`'s `RosterEntry` also grew a `serverGroups` field (PHA-3786):
`{"clientId":u16,"nickname":string,"muted":bool,"away":bool,"serverGroups":[string]}`.
The moderation tool gate (`tools.moderation.allowGroups`) lives on the plugin
side, not here — the Sexton just reports group membership on the wire.
| 0x08 | `channel_tree` | `[{"channelId":u64,"name":string,"occupants":[{"clientId":u16,"nickname":string,"muted":bool,"away":bool}]}]` (PHA-3784, answer to `list_channels`) | — |

Message types the bridge accepts (`in`):

| type | name          | header                                          | payload              |
|-----:|---------------|--------------------------------------------------|----------------------|
| 0x81 | `voice_audio` | `{}`                                              | pcm16 (model's voice)|
| 0x82 | `music_audio` | `{}`                                              | pcm16 (music lane)   |
| 0x83 | `music_gain`  | `{"gain":f32}` (0..1, multiplies the music lane before ducking) | — |
| 0x84 | `clear_voice` | `{}` (barge-in: drop all queued voice samples)   | —                    |
| 0x85 | `say_text`    | `{"text":string}` (fallback TTS hook; only does anything if `--tts-webhook-url` is configured, see README) | — |
| 0x86 | `join`        | `{"channel":string}` (name or numeric id as a string) | —               |
| 0x87 | `mute`        | `{"muted":bool}` (stops/resumes outbound audio; does not touch the TS mute flag) | — |
| 0x88 | `poke`        | `{"clientId":u16,"text":string}`                  | —                    |
| 0x89 | `send_text`   | `{"target":"channel"\|"server"\|u16,"text":string}` (numeric string/number targets a client PM) | — |
| 0x8A | `client_kick` | `{"clientId":u16,"fromServer":bool,"reason":string?}` (PHA-3786) | — |
| 0x8B | `ban_client`  | `{"clientId":u16,"durationSecs":u64?,"reason":string?}` (PHA-3786; no `durationSecs` = permanent) | — |
| 0x8C | `ban_del`     | `{"banId":u32}` (PHA-3786) | — |
| 0x8D | `ban_list`    | `{}` (PHA-3786: requests the ban list; the server's response is not parsed yet, see `moderation_result`'s detail) | — |
| 0x8E | `client_move` | `{"clientId":u16,"channelId":u64}` (PHA-3786: move another client — distinct from `join`, which moves the bot itself) | — |
| 0x8F | `client_edit_mute` | `{"clientId":u16,"muted":bool}` (PHA-3786: implemented via talk-power revocation, not a true client-side mute) | — |
| 0x90 | `channel_edit` | `{"channelId":u64,"name":string?,"topic":string?}` (PHA-3786) | — |
| 0x91 | `channel_create` | `{"name":string,"parentId":u64?}` (PHA-3786) | — |
| 0x92 | `channel_delete` | `{"channelId":u64,"force":bool}` (PHA-3786) | — |
| 0x93 | `server_edit` | `{"name":string?,"welcomeMessage":string?}` (PHA-3786) | — |
| 0x94 | `server_group_add_client` | `{"serverGroupId":u64,"clientId":u16}` (PHA-3786) | — |
| 0x95 | `list_channels` | `{}` (PHA-3784: ask for the full channel tree; answered async with `channel_tree` 0x08, no request id) | — |

Every 0x8A-0x94 command answers with `moderation_result` (0x07). None of them
enforce authorization themselves — the Sexton trusts whatever command it is
given, same failure model as `poke`/`send_text` above (the plugin is the
bridge's only caller). The server-group allowlist
(`tools.moderation.{kick,ban,edit,allowGroups}`) is enforced by the plugin
before it ever sends one of these frames.

No handshake beyond the WebSocket upgrade: on connect the bridge immediately
sends the current `state` and `roster`, in that order, before any live events.
Both are also broadcast whenever they change, so a client that connects while
the bridge is still dialling the server gets `{"connected":false}` and an empty
roster first, then the real ones once the channel is joined. Unknown inbound
message types are logged and ignored, not fatal to the connection.

`roster` is the channel's roster, and the bot is in it like any other client.
`state.ownClientId` is which entry is the bot: a consumer that opens a session
per speaker, or counts the humans in the room, must exclude it. It is absent
while `connected` is false, and it changes on every reconnect — TeamSpeak hands
out a fresh runtime `clientId` per session — so it is published with the state
that established it rather than configured anywhere. `state` always precedes the
`roster` it describes, both in the connect snapshot and on a reconnect.

## Mixer / ducking

Two lanes feed one Opus stream sent to the channel:

- **Voice lane** — from `voice_audio`. Always at full gain.
- **Music lane** — from `music_audio`, scaled by the `music_gain` multiplier
  (default 1.0), then by the duck envelope.

Duck envelope: target gain is `duckGain` (default `0.25`, override via
`--duck-gain`) whenever the voice lane has queued samples *or* any human
`speaker_start` is currently active in the channel; otherwise target is
`1.0`. The envelope ramps linearly toward the target, reaching it within
50 ms on the way down (2 × 20 ms frames) and within 800 ms on the way back up
(40 × 20 ms frames), per the spec.

Codec selection per outbound frame: `OpusMusic` @ 64 kbps whenever the music
lane contributed non-silent samples to that frame, `OpusVoice` otherwise
(tsclientlib's default voice bitrate).
