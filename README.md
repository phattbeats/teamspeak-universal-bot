# plnt-sexton

The Sexton: a bot that gives teamspeak.phatt.vip's channel chat memory, voice,
and a handful of tools. Tracked as the PHA-3099 epic in Paperclip.

TeamSpeak does not persist channel text chat — anyone who joins a channel
late sees nothing that was said before they arrived. The Sexton fixes that,
and is the platform the later voice/tool work builds on.

## Scope

- **v1 — chat memory** (PHA-3173, PHA-3107): rolling last-N messages written
  into the channel description, a catch-up PM on join, and a full markdown
  log on disk. Content-only — no joins/leaves/moves/mutes/system messages,
  just what people typed.
- **Audio bridge** (PHA-3174, `plnt-ts-bridge`): sidecar exposing per-speaker
  PCM out, mixed PCM in, and a music lane with ducking over a local
  WebSocket.
- **Realtime voice channel plugin** (PHA-3175): OpenClaw `extensions/teamspeak`
  channel plugin putting a realtime voice runtime in the channel, with
  Discord config parity.
- **Voice tools v1** (PHA-3176): `play_music` (ducked lane), `stop`,
  `what_did_i_miss`, `who_is_here`, `poke`.

Server prerequisites (30033/tcp forward, Sexton server group + permissions,
Docker network placement) and standing decisions (realtime provider, monthly
cost ceiling, the Sexton's voice, the "Sexton is listening" notice) are
tracked separately as PHA-3172 and PHA-3177.

## Implementation notes

- Rust on [tsclientlib](https://github.com/ReSpeak/tsclientlib), proven
  against the live server in PHA-3073 (reuses that voicespike build). Text
  messages arrive as `StreamItem::MessageEvent` / `events::Event::Message`;
  channel descriptions are edited via
  `con.get_state()?.channels[id].edit().set_description(...)`; private
  messages via `send_textmessage` / `Message::client(...)`.
- One bot client per watched channel, channels listed in a config file.
- Runs as a Docker container on the TS6 host's Docker network (not on
  PHATT-RAID reaching over the public IP — that hairpins and gets
  flood-scored). `restart: unless-stopped`, reconnect with backoff.
- Channel description limit is 8192 bytes (not 200 — that's the *client*
  description limit).

## Definition of done

Someone in the channel says "Sexton, what did I miss" and hears the last
messages within two seconds; "Sexton, play some smooth jazz" starts music
that ducks when anyone speaks and stops on "Sexton, stop"; the rolling
description and catch-up PM keep working underneath; and the group has been
told the Sexton listens.

## Status

`ts-bridge/` (PHA-3174, audio sidecar) has a working Rust implementation —
see `ts-bridge/README.md` for how to run it and what's not yet verified
against the live server. v1 chat memory (PHA-3173) and the rest of the epic
are still planning/blocked. See the PHA-3099 epic and its children in
Paperclip for current status and decisions.
