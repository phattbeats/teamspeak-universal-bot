# sexton

The Sexton — a persistent chat-memory bot for `teamspeak.phatt.vip` (TeamSpeak 6).

TeamSpeak does not persist channel chat, so anyone who joins a channel late sees nothing.
The Sexton sits in a channel, watches user text messages, and makes them readable after the
fact — and tells the room he is doing it.

## Behaviour

1. **Catch-up PM.** When a client arrives in the watched channel — either by connecting straight
   into it or by moving in from elsewhere — it gets a private message with the last 15 messages
   (or a "nothing logged yet" note). The message ring behind it is in memory only (last 200), so
   on connect it is **rehydrated from the disk log below** — yesterday's file then today's,
   newest lines kept (PHA-3217). Without that the first catch-up after every container restart
   is empty. The disk format *is* the wire format, so this is a parse of
   `HH:MM  nickname: message`, not a second serialisation, and it is fail-open: a missing,
   unreadable or malformed log is skipped and never stops the bot connecting. Rate-limited to one PM per client per 10 minutes so
   channel-hopping does not spam, and suppressed for the first five seconds after the bot itself
   connects so a restart does not PM everyone already in the room.
2. **Welcome PM.** The first time a client is ever caught up, and only the first time, the
   catch-up is preceded by a one-time notice saying what the Sexton does — that the channel is
   listened to and written down, that most transcription happens on the house server, and that
   hard or busy segments go out to MiniMax, so anything said aloud can leave the room. Announced,
   not discovered (PHA-3177 draft B, PHA-3305, copy revised on PHA-3458). A **stage-two PM** —
   how to use the wake names — follows separately, the first time that client calls one out.
   Neither is the catch-up PM, and neither shares its 10-minute window: each is keyed on the
   client's TeamSpeak uid, which survives reconnects, and the uid lists are written to
   `<log-dir>/<channel-name>/.welcomed` and `.addressed` so a container restart does not
   re-introduce the Sexton to the whole room. Fail-open: a lost list costs one repeated PM,
   never a failed connect. Clients whose uid the server has not given us fall back to a
   session-only key, which is never written down.
3. **Full log on disk.** Every message is appended to `<log-dir>/<channel-name>/YYYY-MM-DD.md`
   as markdown, one line per message, same format.

**PHA-3424 removed the rolling log in the channel description** (PHA-3173/PHA-3217): every
`channeledit` fired a channel-edit notification sound in TS6, and the catch-up PM and disk log
above already cover the same ground. There is no longer any per-message or on-connect
`channeledit` at all — the channel description is untouched by the bot. The on-connect
rehydration survives the removal: it feeds the catch-up PM, not just the old description.

### HARD RULE: the notice discloses that audio can leave the room

The old rule here held stage 2 of the welcome back until the voice lane was real, and forbade
the line `your voice doesn't leave the house` while any metered hosted STT could be in the path.
**Both halves are discharged as of PHA-3458.** PHA-3228 landed the lane, and Brandon's
2026-09-12 decision put a hosted second pass behind it: whisper.cpp transcribes every segment on
the house server, and MiniMax `asr-1.0` re-hears the ones whisper is weak on (low confidence,
long, or explicitly escalated). The `$0`-ceiling wording rule from PHA-3177 is retired, not
deferred — it was traded for accuracy, deliberately.

What replaces it: **the notice must say that audio can leave the room, and name where it goes.**
The copy is approved verbatim on PHA-3458 and lives in `src/main.rs` as `WELCOME_PM` (stage one,
on first catch-up), `ADDRESSED_PM` (stage two, the first time a client calls a wake name), and
`CHANNEL_DESCRIPTION` (one line, a server-side edit — PHA-3424 took the description away from
this bot, so nothing here writes it). `the_notice_is_the_approved_copy_and_discloses_that_audio_leaves`
fails on an edit to any of the three, on the welcome dropping `MiniMax` or the leaves-the-room
sentence, and on the retired promise coming back.

Keep the copy next to the STT config (`transcription.provider` / `.secondary` in the teamspeak
plugin). **If the primary/secondary order ever flips back so that no audio leaves the box, the
copy flips in the same change.**

Stage two is keyed and persisted exactly like stage one, in `<log-dir>/<channel-name>/.addressed`
beside `.welcomed` — once per client, ever, surviving restarts, fail-open. The wake-name match is
whole-word (`mentions_wake_name`): `transplant` is not someone calling for the Plant, and a
stage-two PM spent on a false positive cannot be taken back.

### HARD RULE: content only

Only user-authored text messages targeted at the watched channel, sent by a client actually in
that channel, and not the bot's own messages, are logged or displayed. Joins, leaves, moves,
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
network (`phattvip`). PHATT-RAID and the TeamSpeak server share one public IP, so connecting via
the public hostname hairpins out and back in and gets flood-scored as if it came from the open
internet, which is what produced the earlier `ConnectFailedBanned` loop.

`--public-fallback` switches the target to `teamspeak.phatt.vip` for running the bot somewhere
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

## Audio / voice bridge (PHA-3342)

Brandon: "i want everything running off of one docker container / one bot
account." Before this, the Sexton connected as `Sexton` for text and a
separate `ts-bridge` container connected as `Sexton-Bridge` for audio — two
client slots in the channel roster for one bot. PHA-3341 collapsed that to
one `tsclientlib::Connection`, fronted by a Unix-socket IPC (`bridge-proto`)
to a still-separate `ts-bridge` container. PHA-3342 removes that second
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
see the PHA-3342 PR description for the fuller reasoning.

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
| `bridge-test` | drive the audio/voice bridge WebSocket from outside — plays test tones, logs every frame received back (PHA-3174 acceptance). Formerly `ts-bridge`'s binary of the same name; see `tools/*.py` for stdlib-Python equivalents that don't need a Rust toolchain. |

`send-test` takes `--script`, a comma-separated list of steps, so a run is deterministic:

| step | effect |
| --- | --- |
| `say:<text>` | send `<text>` to the watched channel |
| `mute` / `unmute` | set/clear `client_input_muted` |
| `hop` | create (if needed) and join a temporary side channel |
| `back` | move back into the watched channel |
| `wait:<ms>` | pump the connection for `<ms>` milliseconds |

It prints every private message it receives and, at the end, the channel description as the
server returns it. `-i` reuses an identity so an account can reconnect as itself. The PHA-3107
recipe is two concurrent invocations — see `deploy/verify.sh`.

## Running

See `deploy/sexton-compose.yml`. The image is `phattbeats/sexton:latest`, built from the
`Dockerfile` here, and runs on the `phattvip` Docker network on PHATT-RAID with:

- the pinned identity mounted read-only at `/run/secrets/sexton-identity`
- the avatar baked into the image at `/usr/local/share/sexton-avatar/brandon.png`
- logs persisted at `/mnt/user/appdata/sexton` (mounted at `/var/sexton-logs`)
- the audio bridge's WebSocket exposed to sibling containers on `:9099` (PHA-3342)

```
sexton -a teamspeak6-server -p 9987 -n Sexton -c "General Shit" \
       -i "$(cat /run/secrets/sexton-identity)" \
       -A /usr/local/share/sexton-avatar/brandon.png \
       -l /var/sexton-logs \
       --ws-bind 0.0.0.0:9099 \
       --duck-gain 0.25
```

PHATT-RAID has no `docker compose` plugin, so production runs the equivalent `docker run` in
`deploy/deploy.sh` (copied to `/mnt/user/appdata/sexton/deploy.sh` on the box). Keep it and the
compose file in step.

PHA-3342: the build context moved from `sexton/` to the repo root (the Sexton now has a
workspace path dependency on `bridge-proto`) — see `Dockerfile`'s header comment and
`deploy/sexton-compose.yml`'s `build:` stanza.

## Liveness

The container healthcheck greps PID 1's argv (`grep -qa /usr/local/bin/sexton /proc/1/cmdline`).
The runtime image is `debian-slim` and ships no `pgrep`, so the previous `pgrep -f` check exited
127 on every interval and the container reported `unhealthy` continuously (PHA-3217).

There is no longer an `--on-connected` hook wired up in production. The flag still exists and runs
any script you point it at, but the script that used to be baked into the image posted a "Sexton
back online" comment to Paperclip with a bearer mounted from the host, and that token was revoked —
it 403'd silently on every connect. A liveness signal that fails silently is worse than none, and
re-minting the key needs board-level access the bot does not have, so the hook, the script and the
mounted secret were all removed. Restart evidence is the healthcheck plus `docker logs sexton`
(`connected; channel resolved`, `rehydrated message history from disk`).

Tracking: PHA-3099 (epic), PHA-3173 (this version), PHA-3107 (verification recipe),
PHA-3341/PHA-3342 (audio bridge consolidation),
PHA-3217 (history rehydration, hook removal),
PHA-3424 (removed the per-message/on-connect channel description rewrite).
