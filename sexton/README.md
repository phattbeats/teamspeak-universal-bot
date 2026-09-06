# sexton

The Sexton — a persistent chat-memory bot for `teamspeak.phatt.vip` (TeamSpeak 6).

TeamSpeak does not persist channel chat, so anyone who joins a channel late sees nothing.
The Sexton sits in a channel, watches user text messages, and makes them readable after the
fact in three places.

## Behaviour

1. **Rolling log in the channel description.** Every user text message in the watched channel
   rewrites the channel description to the most recent messages, newest at the bottom, format
   `HH:MM  nickname: message`, with the header `— last messages, kept by the Sexton —` on top.
   The message window is chosen dynamically to fit a **7500-byte** budget (the server's hard cap
   for `TS3_MAX_SIZE_CHANNEL_DESCRIPTION` is 8192).
   The message ring is in memory only, so on connect it is **rehydrated from the disk log below**
   (yesterday's file then today's, newest lines that fit the same 7500-byte budget) before the
   first `channeledit`. Without that a container restart overwrote a populated description with a
   bare header. The disk format *is* the wire format, so this is a parse of
   `HH:MM  nickname: message`, not a second serialisation. It is fail-open: a missing, unreadable
   or malformed log is skipped and never stops the bot connecting.
2. **Catch-up PM.** When a client arrives in the watched channel — either by connecting straight
   into it or by moving in from elsewhere — it gets a private message with the last 15 messages
   (or a "nothing logged yet" note). Rate-limited to one PM per client per 10 minutes so
   channel-hopping does not spam, and suppressed for the first five seconds after the bot itself
   connects so a restart does not PM everyone already in the room.
3. **Full log on disk.** Every message is appended to `<log-dir>/<channel-name>/YYYY-MM-DD.md`
   as markdown, one line per message, same format.

### HARD RULE: content only

Only user-authored text messages targeted at the watched channel, sent by a client actually in
that channel, and not the bot's own messages, are logged or displayed. Joins, leaves, moves,
mutes, unmutes, away changes, kicks, bans, pokes, channel edits and server messages never reach
the description, the PM or the disk log.

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

## Binaries

| binary | purpose |
| --- | --- |
| `sexton` | the bot itself |
| `probe-channels` | connect, dump the channel tree, exit — used to confirm reachability and channel names |
| `send-test` | connect as another identity and run a scripted sequence against a channel — used for the verification recipe |

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

```
sexton -a teamspeak6-server -p 9987 -n Sexton -c "General Shit" \
       -i "$(cat /run/secrets/sexton-identity)" \
       -A /usr/local/share/sexton-avatar/brandon.png \
       -l /var/sexton-logs
```

PHATT-RAID has no `docker compose` plugin, so production runs the equivalent `docker run` in
`deploy/deploy.sh` (copied to `/mnt/user/appdata/sexton/deploy.sh` on the box). Keep it and the
compose file in step.

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
(`connected; channel resolved`, `rehydrated description history from disk`).

Tracking: PHA-3099 (epic), PHA-3173 (this version), PHA-3107 (verification recipe),
PHA-3217 (description rehydration, hook removal).
