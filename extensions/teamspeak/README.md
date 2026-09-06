# `extensions/teamspeak` — OpenClaw TeamSpeak channel plugin

Puts an OpenClaw realtime voice session in a TeamSpeak channel. The plugin never
speaks TeamSpeak itself: it talks to the **plnt-ts-bridge** sidecar
(`../../ts-bridge`, PHA-3174) over a local WebSocket, and the bridge owns the
TeamSpeak connection, Opus, and the music/ducking mixer.

```
TeamSpeak server ──9987/udp── ts-bridge ──WebSocket── extensions/teamspeak ──── realtime provider
                               (Rust)      binary       (this plugin)            (OpenAI, …)
                                           frames
```

This is the TeamSpeak counterpart of `extensions/discord/src/voice`, with
`@discordjs/voice` replaced by the bridge socket. It is structured to be sent
upstream — OpenClaw issue #22932 asked for a TeamSpeak channel and was closed
stale.

## How it maps to Discord

| Discord | TeamSpeak |
| --- | --- |
| one realtime session per speaking user, keyed by Discord user id | one per client, keyed by the bridge's runtime `clientId`, labelled by nickname |
| `@discordjs/voice` receive stream | bridge `speaker_audio` frames |
| one `AudioPlayer` per room | `RoomPlaybackQueue`, one `voice_audio` lane per channel |
| `speaker_start` from the voice gateway | bridge `speaker_start` frame |
| slash commands (`/vc join`…) | text commands `!vc join\|leave\|mute`, `!sexton status` |
| stereo 48k ⇄ mono 24k | mono 48k ⇄ mono 24k (TeamSpeak audio is already mono) |

Sessions are keyed by `clientId` rather than nickname on purpose: TeamSpeak
nicknames change mid-session and are not unique, so keying by them would merge
two people into one provider connection. A rename relabels a live session.

The bridge's `roster` is the channel's roster, and the bot is in it like anyone
else. `state.ownClientId` says which entry is us; the runtime excludes it, so
the Sexton neither opens a session on its own audio nor counts itself toward
`humanParticipants`. That count is what drives the wake gate, so this needs a
bridge new enough to publish the field (`ts-bridge` PROTOCOL.md 0x06). Against
an older bridge the gate would engage with one human in the channel.

### Wake names and barge-in

Both come from the shared SDK policy, so behavior tracks Discord:

- `voice.realtime.requireWakeName` unset → **automatic**: no wake name needed
  with one human in the channel, required once a second joins.
- Barge-in is disabled whenever the wake gate is active — otherwise one person's
  crosstalk would cut off an answer addressed to someone else.
- `voice.realtime.minBargeInAudioEndMs` (default 250 ms) is the echo guard. The
  bridge has no provider-native echo handler, so the guard runs locally in
  `RoomPlaybackQueue`: a `speaker_start` arriving before the assistant has
  played that much audio is treated as our own voice coming back through the
  channel, not as an interruption.

## Configuration

The `voice` block uses the same keys and defaults as Discord's
(`DiscordVoiceConfig` / `DiscordVoiceRealtimeConfig`), so a working Discord
voice block can be copied across unchanged.

```jsonc
{
  "channels": {
    "teamspeak": {
      "bridgeUrl": "ws://ts-bridge:9099",   // or TEAMSPEAK_BRIDGE_URL
      "channel": "General Shit",
      "commandPrefix": "!",                  // default
      "commandAllowFrom": [11, 12],          // optional; unset = anyone in channel
      "voice": {
        "enabled": true,
        "mode": "agent-proxy",               // default
        "model": "…",
        "agentSession": { "mode": "voice" },
        "realtime": {
          "provider": "openai",
          "model": "gpt-realtime-2.1",
          "speakerVoice": "cedar",
          "requireWakeName": null,           // unset = automatic
          "wakeNames": ["sexton"],
          // the routed agent's profile files, folded into the realtime
          // instructions; [] disables. Unset means all three.
          "bootstrapContextFiles": ["IDENTITY.md", "USER.md", "SOUL.md"],
          "bargeIn": true,
          "minBargeInAudioEndMs": 250,
          "toolPolicy": "owner",
          "consultPolicy": "always"
        }
      },
      "tools": {
        "enabled": true,                     // default; false removes every tool
        "logDir": "/mnt/user/appdata/sexton", // or TEAMSPEAK_SEXTON_LOG_DIR
        "catchUpDefaultLines": 15,           // default
        "catchUpMaxLines": 40,               // default
        "music": {
          "enabled": true,                   // false keeps the other tools
          "ytdlpPath": "yt-dlp",             // default
          "ffmpegPath": "ffmpeg",            // default
          "cookiesFile": "/etc/sexton/cookies.txt", // optional
          "ytdlpArgs": [],                   // extra yt-dlp flags
          "defaultVolume": 0.6,              // music lane gain, before ducking
          "resolveTimeoutMs": 20000,         // yt-dlp search timeout
          "prebufferMs": 240                 // jitter buffer = stop latency
        }
      }
    }
  }
}
```

`voice.mode: "stt-tts"` is not implemented for TeamSpeak; the runtime logs and
declines rather than starting a session that cannot speak.

## Chat commands

TeamSpeak has no slash-command registry, so commands are prefixed text parsed
out of `text_message` frames. Replies go back where the command came from — a
PM stays a PM.

- `!vc join [channel]` — join the configured channel, or a named one
- `!vc leave` — close every speaker session and stop playback
- `!vc mute [on|off]` — mute the outbound lane (bare form toggles); muting also
  drops audio already queued
- `!sexton status` — bridge/channel/session/wake-name/barge-in state, plus the
  music lane when the music tools are enabled

Text that is not addressed to us — including another bot's `!roll` — draws no
reply.

## Realtime tools

Tools are registered through the harness `tools` list, and calls come back on
`onToolCall` → `submitToolResult` — the same path Discord uses for
`openclaw_agent_consult`. The voice runtime builds one registration and hands
the same one to every speaker session; the tools execute here, in the plugin,
against the bridge socket the runtime already owns. A call that throws, or names
a tool that is not registered, still settles as `{ ok: false, error }`, because
the provider blocks its turn until every outstanding call has a result.

| tool | arguments | what it does |
|---|---|---|
| `play_music` | `query` or `url` | yt-dlp resolves a stream, ffmpeg decodes it, frames go to the bridge's `music_audio` lane. The bridge ducks it while anyone speaks. |
| `stop_music` | — | Kills the decode. Reports whether anything was playing. |
| `set_volume` | `volume` (0–1) | Sets the music lane gain (`music_gain`). A bare number over 1 is read as a percentage. |
| `what_did_i_miss` | `minutes?` | Reads the Sexton logger's markdown log for the current channel back for the model to read aloud. |
| `who_is_here` | — | The bridge's current roster, with muted/away flags. |
| `poke` | `nickname`, `text` | Resolves the spoken nickname against the roster, then sends bridge `poke`. |

Every call is logged with caller, arguments, outcome and duration:

```
teamspeak tool: play_music caller=brandon#11 args={"query":"smooth jazz"} ok=true 842ms
```

The tool descriptions ask for a short spoken confirmation. The Plant's contempt
for what you asked it to play belongs in the agent's instructions, not here.

### `play_music` and the music lane

The pipeline is TS3AudioBot's (PHA-3099 finding 8), with the Opus encode left to
the bridge:

```
yt-dlp -f bestaudio/best --no-playlist --print '%(title)s\t%(urls)s' 'ytsearch1:<query>'
ffmpeg -i <url> -vn -ac 1 -ar 48000 -f s16le pipe:1
-> 20 ms frames -> bridge music_audio (0x82)
```

Two things are deliberate:

- **The plugin paces the stream, the bridge does not.** ts-bridge's music queue
  is unbounded and has no clear path, so writing at decode speed would park a
  whole track in the sidecar's memory and make `stop_music` a no-op for minutes.
  Frames leave on a wall-clock schedule with a small prebuffer, and
  `tools.music.prebufferMs` is therefore also the worst-case stop latency.
- **No shell.** The spoken query reaches yt-dlp as a single argv element.

Music stops on `stop_music`, `!vc leave`, `!vc mute on`, a bridge disconnect,
and runtime shutdown.

**Image requirements.** The gateway image needs `yt-dlp` and `ffmpeg` on PATH.
Per the yt-dlp wiki, YouTube challenges datacenter IPs, so also install the
[`bgutil-ytdlp-pot-provider`](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
plugin and keep yt-dlp itself current — it breaks against YouTube changes on the
order of weeks, so pin nothing and update it on image rebuild:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3-pip \
 && pip3 install --break-system-packages --no-cache-dir -U yt-dlp bgutil-ytdlp-pot-provider \
 && rm -rf /var/lib/apt/lists/*
```

If a throwaway-account cookie file is mounted, point `tools.music.cookiesFile`
at it; it is passed to yt-dlp as `--cookies`.

### `what_did_i_miss` and the log

The catch-up reads the Sexton logger's own files —
`<tools.logDir>/<channel>/YYYY-MM-DD.md`, lines `HH:MM  nickname: message`,
today's and yesterday's — rather than keeping a second history. That means what
the Sexton reads aloud, what the channel description shows, and what a joiner
gets by PM are the same text, and the logger's hard rule (user-authored messages
only, no joins/mutes/system noise) holds here for free.

Mount the logger's log volume into the gateway container read-only, or set
`TEAMSPEAK_SEXTON_LOG_DIR`. With no log present the tool answers "nothing
logged yet" rather than failing.

## Building it into the Gateway image

Copy this directory into an OpenClaw source checkout as `extensions/teamspeak`,
then build with the plugin selected (`docs/install/docker.md`, "Source-built
images with selected plugins"):

```bash
OPENCLAW_EXTENSIONS=teamspeak docker compose build
```

### Using it in an OpenClaw checkout

Two files are shaped for this standalone repo and should be adjusted on the way
in:

1. `tsconfig.json` — replace the whole file with
   `{ "extends": "../tsconfig.package-boundary.base.json" }`.
2. `test/sdk-stubs/`, `vitest.standalone.config.ts` — delete them. They exist
   only so the plugin can be tested outside a checkout; inside one the real SDK
   resolves and the repository's own vitest runs the tests.

The plugin imports the private-local `openclaw/plugin-sdk/realtime-voice*`
subpaths the way `extensions/discord/src/voice` does. That is the accepted cost
recorded in PHA-3175.

## Tests

```bash
npm install
npm test        # vitest, standalone
npm run typecheck
```

`test/mock-bridge.ts` is a mock plnt-ts-bridge: it speaks the same binary
protocol over an in-memory socket and replays recorded frame scripts, so the
suite runs with no TeamSpeak server. The three acceptance assertions from
PHA-3175 are `test/speaker-sessions.test.ts` (sessions open/close on roster),
`test/wake-gate.test.ts` (gating with 1 vs 2 humans), and
`test/room-playback.test.ts` (barge-in clears the queue);
`test/voice-runtime.test.ts` exercises all of it end-to-end through the frame
codec.

The PHA-3176 tools are covered by `test/music.test.ts` (yt-dlp arguments and the
pacing/backpressure/stop behavior, with both binaries faked), `test/tools.test.ts`
(definitions, argument handling, nickname resolution, the timing log),
`test/catch-up.test.ts` (the logger's line grammar and file layout, including one
real file on disk) and `test/voice-runtime-tools.test.ts` (a tool call in, bridge
`poke` / `music_audio` / `music_gain` frames out).

### What the standalone suite does and does not prove

`test/sdk-stubs/realtime-voice.ts` stands in for the SDK. It is split
deliberately:

- **Faithful** — `resamplePcm` is the real implementation, vendored verbatim
  (`test/sdk-stubs/vendor/audio-codec.ts`, pinned to openclaw@fc1877d7), and the
  wake-name/barge-in policy helpers are line-for-line copies. Assertions against
  these are assertions about real shared behavior.
- **Inert** — provider resolution and the session harness are minimal fakes. The
  speaker-session tests inject a fake harness through `deps`, so they cover this
  plugin's wiring, not the provider stack.

Not covered here, and needing a real gateway: the live provider connection, and
`src/channel.ts` / `src/accounts.ts` / `src/bridge/ws-socket.ts`, which import
SDK subpaths that are not stubbed and are excluded from the standalone
typecheck.

`src/channel.ts` is the one to read before a deploy, because it is both
unverifiable here and the file that decides whether anything runs at all: its
`gateway.startAccount` is the gateway's only lifecycle seam for a channel
account. It resolves the agent route, reads the bootstrap context files, starts
one voice runtime, and stays pending until the account is aborted. The first
thing `OPENCLAW_EXTENSIONS=teamspeak docker compose build` proves is that this
file compiles against the real SDK.
