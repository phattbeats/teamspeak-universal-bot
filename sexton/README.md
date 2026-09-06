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
2. **Catch-up PM.** When a client moves into the watched channel, it gets a private message with
   the last 15 messages (or a "you are caught up" note). Rate-limited to one PM per client per
   10 minutes so channel-hopping does not spam.
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

## Binaries

| binary | purpose |
| --- | --- |
| `sexton` | the bot itself |
| `probe-channels` | connect, dump the channel tree, exit — used to confirm reachability and channel names |
| `send-test` | connect as a second identity, join a channel, send N messages — used for the verification recipe |

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

Tracking: PHA-3099 (epic), PHA-3173 (this version), PHA-3107 (verification recipe).
