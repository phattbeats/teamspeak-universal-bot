# teamspeak-universal-bot

The Sexton: a bot that gives teamspeak.phatt.vip's channel chat memory, voice,
and a handful of tools. Tracked as the #3099 epic in Paperclip.

TeamSpeak does not persist channel text chat — anyone who joins a channel
late sees nothing that was said before they arrived. The Sexton fixes that,
and is the platform the later voice/tool work builds on.

## Deploy

Everything ships as **one container** (#3791): every bot (Sexton, Bexton,
Lexton and the guest stars Rotten Johnny and Trixie) under one OpenClaw
gateway, each with its own TeamSpeak identity, plus the whisper pool,
suno-api, the POT provider and ts-summoner, all supervised in one place.

```
image/build.sh                   # on PHATT-RAID; tags phattbeats/teamspeak-universal-bot:<git sha>
TAG=<sha> image/deploy.sh        # (re)creates the teamspeak-universal-bot container
```

A bot is a persona pack: `personas/<id>/` (workspace markdown, `voice.json`,
`tools.json`, lines, moods, avatar). Add one (or drop it into
`/config/personas/<id>/` on the box) and the next boot gives it a core, a
bridge port, a gateway account, an agent and a summoner entry. See
[`image/README.md`](image/README.md).

## Scope

- **v1 — chat memory** (#3173, #3107): a catch-up PM on join and a full
  markdown log on disk (#3424 removed the earlier rolling last-N-messages
  channel description, since editing it on every message fired a
  channel-edit notification sound). Content-only — no joins/leaves/moves/
  mutes/system messages, just what people typed.
- **Audio bridge** (#3174, `plnt-ts-bridge`): sidecar exposing per-speaker
  PCM out, mixed PCM in, and a music lane with ducking over a local
  WebSocket.
- **Realtime voice channel plugin** (#3175): OpenClaw channel plugin
  putting a realtime voice runtime in the channel, with Discord config
  parity. Lives at [`teamspeak-plugin/`](teamspeak-plugin/) in this repo.
  Split out into its own repo at #3220 so the plugin and the chat logger
  could ship independently; #3580 moved it back once #3341/3342 folded
  them onto one tsclientlib connection and #3428 put them in one image —
  the repo, `phattbeats/openclaw-teamspeak-plugin`, is now archived.
- **Voice tools v1** (#3176): `play_music` (ducked lane), `stop`,
  `what_did_i_miss`, `who_is_here`, `poke`.

Server prerequisites (30033/tcp forward, Sexton server group + permissions,
Docker network placement) and standing decisions (realtime provider, monthly
cost ceiling, the Sexton's voice, the "Sexton is listening" notice) are
tracked separately as #3172 and #3177.

## Implementation notes

- Rust on [tsclientlib](https://github.com/ReSpeak/tsclientlib), proven
  against the live server in #3073 (reuses that voicespike build). Text
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
that ducks when anyone speaks and stops on "Sexton, stop"; the catch-up PM
keeps working underneath; and the group has been told the Sexton listens.

## Universal bot tool catalog

See [`docs/universal-bot/TOOL-CATALOG.md`](docs/universal-bot/TOOL-CATALOG.md)
for the research + implementation notes on turning Sexton/Bexton into
instances of a common tool platform: web search provider choice, the
`tools.allow` wiring, per-persona skill curation, and the live-verify
recipe (#3783/#3788).

## Status

`ts-bridge/` (#3174, audio sidecar) has a working Rust implementation —
see `ts-bridge/README.md` for how to run it and what's not yet verified
against the live server. v1 chat memory (#3173) and the rest of the epic
are still planning/blocked. See the #3099 epic and its children in
Paperclip for current status and decisions.
