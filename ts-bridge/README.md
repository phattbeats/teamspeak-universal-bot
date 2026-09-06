# ts-bridge (PHA-3174)

Audio sidecar for the Sexton: joins a TS6 channel as its own identity and
exposes per-speaker PCM out, mixed PCM in, and a music lane with ducking
over a local WebSocket, so a realtime voice runtime (PHA-3175) doesn't have
to speak TeamSpeak/Opus itself.

See [`PROTOCOL.md`](PROTOCOL.md) for the wire format.

## Running

Container `phattbeats/ts-bridge`, built from the `Dockerfile` here. Append
`docker-compose.snippet.yml` to the TS6 host's compose file — this must run
on the `phattvip` Docker network and connect to `teamspeak6-server:9987` by
container name, not `teamspeak.phatt.vip` (PHA-3172 finding #5: the host and
server share a public IP, so anything reaching over the WAN address
hairpins and gets flood-scored).

Config is entirely environment variables — see `src/config.rs` for the full
list (`TS_SERVER_ADDRESS`, `TS_NICKNAME`, `TS_CHANNEL`, `TS_IDENTITY`,
`TS_PASSWORD`, `WS_BIND`, `DUCK_GAIN`, `TTS_WEBHOOK_URL`).

**Identity**: if `TS_IDENTITY` is unset, the bridge generates a new one on
boot and logs it in the standard TS3 `<counter>V<base64key>` form (the same
shape the official client persists — this is deliberately not a custom
format, per the standing feedback in PHA-3172 to follow normal TS bot
practice rather than have a human hand-create an identity first). Capture it
from the logs, put it in `TS_IDENTITY` going forward, and have it added to
the Sexton server group.

## TS6 patches carried in from the epic findings

tsclientlib's own connect handshake does not request the channel list or
subscribe to all channels against TS6 the way it did against the TS3 server
the original voicespike build was proven on (PHA-3099 finding #6). `ts_client.rs`
sends both explicitly right after connect:

- `OutChannelListRequestMessage` (raw `channellist`)
- `state.set_subscribed(true)` (raw `channelsubscribeall`)

PM/poke targets always resolve the live `ClientId` observed on the current
connection (roster, `Event::Message.invoker.id`), never a cached or
database id — TS6 assigns a fresh `ClientId` per session like TS3 does.

## Testing

- `cargo test` covers the binary frame codec and the mixer's duck-envelope
  timing (2 frames / 40 ms attack within the 50 ms budget, 40 frames / 800 ms
  recovery) without needing a server.
- `bridge-test` (`cargo run --bin bridge-test -- ws://<host>:9099 30`) drives
  the WebSocket side of the acceptance test: connects, plays a 440 Hz tone
  into `voice_audio` and a 220 Hz tone into `music_audio`, and logs every
  frame it receives back.

**What's not verified from this sandbox:** this code was written in an
environment with no C toolchain (no `cc`) and no network path to the
`phattvip` Docker network or `teamspeak6-server`, so it could not be
compiled or run against the live server here. Compilation and the mixer/
protocol unit tests run in CI (`.github/workflows/ts-bridge.yml`) on a real
runner. The full three-part acceptance test in the issue — (a) both tones
audible, (b) the 220 Hz tone measurably drops ~12 dB while the 440 Hz tone
plays, (c) per-speaker frames from a real talker arrive tagged with its
clientId — needs `bridge-test` run against a deployed `ts-bridge` container
plus a second voicespike-based listener actually sitting in the TS channel,
which is a deployment step (PHATT-RAID / the TS6 host), not something this
agent can do without network access to that host.

## Known simplifications (v1, flagged for follow-up rather than silently done)

- `say_text` (the fallback TTS hook) logs a warning and does nothing else —
  wiring an actual HTTP client for `TTS_WEBHOOK_URL` was left out to avoid
  pulling in a TLS-heavy HTTP client dependency for a hook the issue itself
  marks optional. Push `voice_audio` directly in the meantime.
- `mute` stops the bridge's own outbound audio locally; it does not touch
  the TS `input_muted`/`output_muted` flags, so other clients still see the
  bridge as unmuted in the client list while it's silent.
- Reconnect backoff (1s → 60s, doubling) does not reset after a long-lived
  successful connection; a bridge that's been up for days and then flaps
  briefly will back off as if it were failing repeatedly. Acceptable for v1,
  worth revisiting if reconnect churn shows up in practice.
