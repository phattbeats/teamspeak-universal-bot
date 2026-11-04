# sexton

The Sexton — a persistent chat-memory bot for `your TeamSpeak server` (TeamSpeak 6).

TeamSpeak does not persist channel chat, so anyone who joins a channel late sees nothing.
The Sexton sits in a channel, watches user text messages, and makes them readable after the
fact — and tells the room he is doing it.

## Behaviour

1. **Welcome PM (first time).** The first time a TeamSpeak uid walks in, and only then, it gets
   a private message saying what the bot is, what it **can't** do (hear or speak, while voice is
   off), and what it can. The copy is a persona-pack template (`personas/<id>/welcome.json`,
   `{bot}` and `{digest}` placeholders, lines gated by `when` tokens `voice-on|voice-off|stream|
   no-stream|music|no-music|catchup`), built from the live config: `voice.mode`, the
   `/config/.voice-off` kill switch, `--no-audio`, and whether the stream and music tools are on
   (`SEXTON_CAP_STREAM` / `SEXTON_CAP_MUSIC`, set by `stack.mjs`). A pack without a
   `welcome.json` gets the generic built-in. The `dm` module's test fails if "can't hear you"
   is ever rendered while voice is on (PHA-3305's rule, kept). The welcomed uid list is
   `<log-dir>/<channel-name>/.welcomed`; fail-open, a lost list costs one repeated welcome.
2. **Returning-user update (PHA-4917).** When a known uid comes back, it gets one message:
   the returning greeting and a digest of what it missed, **only if** something new was said.
   The digest covers lines since the uid last *left* (not since the last digest), minus lines
   said while it was present; includes every bot's channel lines (labelled by nick, our own
   channel replies are logged at send time), newest 15 (`dm.maxLines`) then
   `+N earlier lines. Ask me for the rest.`; times are in the process time zone (`server.timezone`
   in bots.json sets `TZ`). Nothing new means nothing sent; `dm.quietNotice: true` brings back
   "All quiet since you left." and still obeys the cooldown. At most one update or returning
   welcome per uid per `dm.cooldownMin` (default 240), keyed on the **uid** and persisted to
   `<log-dir>/<channel-name>/.lastnotified` so restarts do not reset it; joins inside the window
   send nothing and the next DM after it covers them (the earliest unreported leave is kept in
   `.lastleft`). Fail-open like `.welcomed`. The message ring behind the digest is memory-only
   (last 200) and is **rehydrated from the disk log** on connect (#3217): the disk format *is*
   the wire format, a parse of `HH:MM  nickname: message`. tsclientlib may not have a uid the
   instant a client joins/moves; the update defers until it does. Suppressed for the first five
   seconds after the bot connects. Config: `bots.json` `dm` block, stack-wide and per bot
   (`noWelcome` / `noCatchup` still work as aliases), passed to the core as `SEXTON_DM_*` env.
3. **Full log on disk.** Every message is appended to `<log-dir>/<channel-name>/YYYY-MM-DD.md`
   as markdown, one line per message, same format.

**#3424 removed the rolling log in the channel description** (#3173/#3217): every
`channeledit` fired a channel-edit notification sound in TS6, and the catch-up PM and disk log
above already cover the same ground. There is no longer any per-message or on-connect
`channeledit` at all — the channel description is untouched by the bot. The on-connect
rehydration survives the removal: it feeds the catch-up PM, not just the old description.

### HARD RULE: the welcome never promises what the config does not do

Capability lines come from the live config, not fixed text. Nothing in the welcome may say the
voice never leaves the box while a hosted STT sits anywhere in the path (the $0-ceiling constraint
from #3177 as a wording rule), and it may not mention the channel description (removed, #3424).

### HARD RULE: content only

Only user-authored text messages targeted at the watched channel, sent by a client actually in
that channel, (and the bot's own channel replies, logged when it sends them) are logged or displayed. Joins, leaves, moves,
mutes, unmutes, away changes, kicks, bans, pokes, channel edits and server messages never reach
the PM or the disk log.

## Avatar

TeamSpeak avatars are a two-step protocol and both steps are required — uploading the file alone
leaves the client with no avatar:

1. `upload_file(ChannelId(0), "/avatar", …)` — writes the image bytes over the file-transfer
   channel.
2. `clientupdate client_flag_avatar=<lowercase md5 hex of the file bytes>` — tells the server
   (and every client) that the avatar exists. Implemented as
   `state.client_update().set_avatar_hash(hash)`.

Both steps log a line (`avatar upload complete`, `avatar hash set hash=…`).

## Networking

Default target is **`teamspeak6-server:9987`** — the TS6 container's name on its own Docker
network (`<ts-network>`). the Docker host and the TeamSpeak server share one public IP, so connecting via
the public hostname hairpins out and back in and gets flood-scored as if it came from the open
internet, which is what produced the earlier `ConnectFailedBanned` loop.

`--public-fallback` switches the target to `your TeamSpeak server` for running the bot somewhere
that is not on that Docker network.

Reconnect backoff is deliberately polite: 60 s initial, ×4 per failure, capped at 1 hour.

## TS6 protocol notes

`tsclientlib` predates TeamSpeak 6. Against TS6 the handshake does not push the channel list or
subscribe to channels unprompted, so the bot explicitly sends `channellist`
(`OutChannelListRequestMessage`) and `channelsubscribeall` (`server.set_subscribed(true)`) after
the first book-events batch. Without those the channel tree stays empty and no text or move
events arrive.

**`tsclientlib` only advances the connection while its event stream is being polled.** Sending a
request and then `sleep`ing for the reply does not work — nothing is received, nothing is applied
to the book, and the reply never arrives no matter how long you wait. Every wait in this crate is
a poll loop against a deadline (`pump`, `wait_for_channel`) for that reason. This is what made the
bot report `channel "General Shit" not found in channel tree` while the channel plainly existed.

The client-side book's `Channel` has no `description` field; the description arrives in
`optional_data` only after an explicit `channelgetdescription`
(`OutChannelDescriptionRequestMessage`). `send-test` uses that to read back what the server
actually stored.

## Audio / voice bridge (#3342)

The goal: everything running off one docker container / one bot
account. Before this, the Sexton connected as `Sexton` for text and a
separate `ts-bridge` container connected as `Sexton-Bridge` for audio — two
client slots in the channel roster for one bot. #3341 collapsed that to
one `tsclientlib::Connection`, fronted by a Unix-socket IPC (`bridge-proto`)
to a still-separate `ts-bridge` container. #3342 removes that second
container: the mixer, the Opus codec, and the public WebSocket server
(`:9099`, wire format in [`PROTOCOL.md`](PROTOCOL.md)) now run inside this
binary, wired directly to the Sexton's own `tsclientlib::Connection` and
20 ms send/receive tick (`src/audio.rs`, `src/mixer.rs`, `src/ws_server.rs`,
`src/protocol.rs` — ported from `ts-bridge/src/{ts_client,mixer,ws_server,
protocol}.rs`).

The bridge-proto crate's Unix-socket layer (`codec.rs`/`handshake.rs`) is
**not** used here: with no second process left to dial it, a self-dial
loopback socket inside one binary would be an extra moving part for no
gain. `BridgeEvent`/`BridgeCommand`/`Snapshot` are reused as the in-process
vocabulary between the connection's event loop and the WS server instead —
see the #3342 PR description for the fuller reasoning.

Config, formerly `ts-bridge`'s env vars, is now flags on `sexton` (matching
its existing CLI style):

| flag | replaces | default |
| --- | --- | --- |
| `--ws-bind` | `WS_BIND` | `0.0.0.0:9099` |
| `--duck-gain` | `DUCK_GAIN` | `0.25` |
| `--tts-webhook-url` | `TTS_WEBHOOK_URL` | unset (say_text is a log-only stub either way) |

## Binaries

| binary | purpose |
| --- | --- |
| `sexton` | the bot itself |
| `probe-channels` | connect, dump the channel tree, exit — used to confirm reachability and channel names |
| `send-test` | connect as another identity and run a scripted sequence against a channel — used for the verification recipe |
| `bridge-test` | drive the audio/voice bridge WebSocket from outside — plays test tones, logs every frame received back (#3174 acceptance). Formerly `ts-bridge`'s binary of the same name; see `tools/*.py` for stdlib-Python equivalents that don't need a Rust toolchain. |

`send-test` takes `--script`, a comma-separated list of steps, so a run is deterministic:

| step | effect |
| --- | --- |
| `say:<text>` | send `<text>` to the watched channel |
| `mute` / `unmute` | set/clear `client_input_muted` |
| `hop` | create (if needed) and join a temporary side channel |
| `back` | move back into the watched channel |
| `wait:<ms>` | pump the connection for `<ms>` milliseconds |

It prints every private message it receives and, at the end, the channel description as the
server returns it. `-i` reuses an identity so an account can reconnect as itself. The #3107
recipe is two concurrent invocations — see `deploy/verify.sh`.

## Running

See `deploy/sexton-compose.yml`. The image is `phattbeats/sexton:latest`, built from the
`Dockerfile` here, and runs on the `<ts-network>` Docker network on the Docker host with:

- the pinned identity mounted read-only at `/run/secrets/sexton-identity`
- the avatar baked into the image at `/usr/local/share/sexton-avatar/<avatar>.png`
- logs persisted at `<appdata>/sexton` (mounted at `/var/sexton-logs`)
- the audio bridge's WebSocket exposed to sibling containers on `:9099` (#3342)

`sexton-compose.yml` overrides the image's entrypoint to invoke the binary with explicit
flags directly:

```
sexton -a teamspeak6-server -p 9987 -n Sexton -c "General Shit" \
       -i "$(cat /run/secrets/sexton-identity)" \
       -A /usr/local/share/sexton-avatar/<avatar>.png \
       -l /var/sexton-logs \
       --ws-bind 0.0.0.0:9099 \
       --duck-gain 0.25
```

the Docker host has no `docker compose` plugin, so production runs the equivalent `docker run` in
`deploy/deploy.sh` (copied to `<appdata>/sexton/deploy.sh` on the box). Keep it and the
compose file in step. **Superseded by `image/deploy.sh` (#3428)** — both are kept as the
record of the settings that were proven here, not as a thing to still run.

#3342: the build context moved from `sexton/` to the repo root (the Sexton now has a
workspace path dependency on `bridge-proto`) — see `Dockerfile`'s header comment and
`deploy/sexton-compose.yml`'s `build:` stanza.

### Standalone / bring-your-own-OpenClaw (#3798)

This same `Dockerfile` is also published as `ghcr.io/phattbeats/plnt-ts-bridge` — the
bridge half alone, for someone who already runs their own OpenClaw gateway elsewhere and
just wants a TeamSpeak client to point its `teamspeak` channel plugin at (see
[`docs/bring-your-own-openclaw.md`](../docs/bring-your-own-openclaw.md)). The default
entrypoint there is `sexton/docker-entrypoint.sh`, an env→argv wrapper (`TS_BRIDGE_*`), not
the binary directly — `docker run ghcr.io/phattbeats/plnt-ts-bridge` with no args and no env
now fails loudly (`TS_BRIDGE_CHANNEL is required`) instead of launching `sexton` with an
empty `--channel` and failing confusingly later inside tsclientlib. The internal deploy above
is unaffected: `sexton-compose.yml` already overrides `entrypoint:` to call the binary
directly, and `image/Dockerfile` (the all-in-one Sexton/Bexton image) builds its own copy of
`sexton` from `rust-builder` and never uses this `Dockerfile` or its entrypoint at all.

| env var | flag | default |
| --- | --- | --- |
| `TS_BRIDGE_ADDRESS` | `--address` | `teamspeak6-server` |
| `TS_BRIDGE_PORT` | `--port` | `9987` |
| `TS_BRIDGE_PUBLIC_FALLBACK=1` | `--public-fallback` | unset |
| `TS_BRIDGE_NICKNAME` | `--nickname` | `Sexton` |
| `TS_BRIDGE_CHANNEL` | `--channel` | **required** |
| `TS_BRIDGE_CHANNEL_PASSWORD` | `--channel-password` | unset |
| `TS_BRIDGE_IDENTITY_FILE` | `--identity` (file contents) | `/data/identity.txt` |
| `TS_BRIDGE_AVATAR_PATH` | `--avatar-path` | unset (no avatar) |
| `TS_BRIDGE_LOG_DIR` | `--log-dir` | unset (binary default) |
| `TS_BRIDGE_NO_CATCHUP=1` | `--no-catchup` | unset |
| `TS_BRIDGE_WS_BIND` | `--ws-bind` | unset (binary default `0.0.0.0:9099`) |
| `TS_BRIDGE_DUCK_GAIN` | `--duck-gain` | unset (binary default `0.25`) |

`TS_BRIDGE_IDENTITY_FILE` is read on every start, not generated for you: with nothing at that
path the binary mints a new TeamSpeak identity and logs it once
(`identity=<counter>V<key>`, warn level) — copy that exact string into the mounted file before
the *next* restart, or the bot gets a new TeamSpeak UID (and drops out of any server group
it was granted) every time the container recreates. `probe-channels` and `send-test` are
still reachable with `docker run --entrypoint probe-channels ...` — only the default
entrypoint changed.

## Liveness

The container healthcheck greps PID 1's argv (`grep -qa /usr/local/bin/sexton /proc/1/cmdline`).
The runtime image is `debian-slim` and ships no `pgrep`, so the previous `pgrep -f` check exited
127 on every interval and the container reported `unhealthy` continuously (#3217).

There is no longer an `--on-connected` hook wired up in production. The flag still exists and runs
any script you point it at, but the script that used to be baked into the image posted a "Sexton
back online" comment to Paperclip with a bearer mounted from the host, and that token was revoked —
it 403'd silently on every connect. A liveness signal that fails silently is worse than none, and
re-minting the key needs board-level access the bot does not have, so the hook, the script and the
mounted secret were all removed. Restart evidence is the healthcheck plus `docker logs sexton`
(`connected; channel resolved`, `rehydrated message history from disk`).

Tracking: #3099 (epic), #3173 (this version), #3107 (verification recipe),
#3341/#3342 (audio bridge consolidation),
#3217 (history rehydration, hook removal),
#3424 (removed the per-message/on-connect channel description rewrite).
