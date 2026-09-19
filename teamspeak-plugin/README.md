# `extensions/teamspeak` — OpenClaw TeamSpeak channel plugin

> PHA-3580: this directory lives at `teamspeak-plugin/` in
> [`phattbeats/plnt-sexton`](https://github.com/phattbeats/plnt-sexton) —
> `extensions/teamspeak` below is the path it would take if sent upstream
> into an OpenClaw checkout (see "Using it in an OpenClaw checkout"), not
> its path in this repo. It briefly had its own repo,
> `phattbeats/openclaw-teamspeak-plugin` (PHA-3220, now archived), before
> moving back in here once PHA-3341/3342/3428 removed the reason for the
> split.

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

## The stt-tts lane

`voice.mode: "stt-tts"` is the second lane (PHA-3228). It exists because the
realtime lane costs money per minute of open microphone, and Brandon's decision
on PHA-3177 was a **$0 pay-as-you-go ceiling**: no metered per-minute provider
anywhere in the path.

```
speaker_audio ─segment─► whisper.cpp ─wake gate─► OpenClaw agent ─► MiniMax T2A ─► voice_audio
 (48k mono)    per client   (local)                (MiniMax text)     (mp3→48k)     (room queue)
```

Everything outside that middle is shared with the realtime lane: the same bridge
client, roster manager, room playback queue, wake gate, echo guard, and
`!vc` / `!sexton` commands. What changes is that there is no provider session,
so endpointing, gating, and turn ordering are the plugin's job.

```jsonc
"voice": {
  "mode": "stt-tts",
  "wakeNames": ["Sexton"],       // default: routed agent name + "OpenClaw"
  "requireWakeName": true,       // unset = automatic (off at 1 human, on at 2+)
  "bargeIn": true,
  "model": "…",                  // optional LLM override for voice turns
  "streaming": {
    "transcription": {
      "provider": "whisper-local",           // only local ids are accepted
      "url": "http://whisper:8080/inference", // or TEAMSPEAK_WHISPER_URL
      "language": "en",                       // "auto" to let whisper detect
      "timeoutMs": 15000
    },
    "speech": {
      "provider": "minimax",
      "model": "speech-2.8-hd",  // pin a *new-version* id; see below
      "voiceId": "…",            // free-form; any MiniMax system voice id
      "timeoutMs": 20000
    },
    "segmentation": {
      "hangoverMs": 600,         // silence after speaker_stop before closing
      "minSegmentMs": 320,       // shorter than this is a click, not speech
      "maxSegmentMs": 20000      // hard cap on one monologue
    }
  }
}
```

Wake config is read from `voice` first and `voice.realtime` second, so a
PHA-3175 config keeps working; `voice` wins where both are set.

**Local STT is enforced, not advised.** Every transcription provider OpenClaw
registers (deepgram, openai, elevenlabs, mistral) is metered and hosted, so
`voice.streaming.transcription.provider` is checked against a short local
allow-list and the account refuses to start on anything else. The sidecar and
its deploy live in [`../../whisper`](../../whisper). This is also the privacy
answer the channel notice promises: the hot mic never leaves the house.

**Pin new-version MiniMax model ids.** A Coding Plan (`sk-cp-…`) key routes by
model *version*: `speech-2.8-hd` resolves and `speech-2.6-hd` returns error 2056
(`MiniMax-AI/MiniMax-MCP#80`). The same rule applies on the text side. Synthesis
goes through the host TTS runtime and `extensions/minimax`'s registered
`speechProviders` entry, with fallback **disabled** — a silent fallback would
move the lane onto a metered provider.

### What this lane gives up

Both were accepted on the record when the lane was chosen over hosted STT:

- **Latency.** Realtime is sub-second; this is roughly 1.5-3s to first audio.
  Every turn logs `segmentMs`, `sttMs`, `agentMs`, `ttsMs`, `firstAudioMs`, so
  the choice between `speech-2.8-hd` and `speech-2.8-turbo` is a measurement.
- **Barge-in.** `WakeGate.isBargeInEnabled()` keeps its realtime semantics, but
  an interrupt here can only drop queued audio and retire the in-flight turn; it
  cannot truncate a provider mid-utterance, because no provider is holding one.

Known v1 gap: the realtime tools from PHA-3176 (`play_music`, `what_did_i_miss`,
`who_is_here`, `poke`) register on a *provider session*, which this lane does
not have. Voice turns reach the agent's ordinary tool surface instead. The
`!vc` / `!sexton` chat commands are unaffected — the runtime owns those.

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

### `compose_song` and the house band (PHA-3554)

Bexton's lane. Off unless `tools.band.enabled` is `true`, because generation
costs money on every provider that can do it. The agent is the composer — it
writes the title and the lyrics — and `compose_song` hands them to a generator
with a style prompt built from the request (`src/tools/band-vibe.ts`: genre
first, the core instruments, a mood read from the brief, one structure, one
room sound, and at most two rationed extra keywords, so no two songs get the
same prompt). The tool returns **immediately**; a real generator takes minutes,
and a voice turn cannot sit in a tool that long. When the track lands the band
leader announces it over the voice lane ("Ladies and gentlemen, The Velvet Vice
Lounge Band!" and a dozen variations, some sarcastic), waits `introGapMs`, and
starts it on the music lane — the same lane `play_music` uses, so `stop_music`
stops the band too. A failure is spoken in character and recorded for
`band_status`.

```json5
"band": {
  "enabled": true,
  "name": "The Velvet Vice Lounge Band",
  "provider": "minimax",            // or "suno-api", or "command"
  "minimax": { "apiKey": "…", "model": "music-3.0" },       // or MINIMAX_API_KEY
  "sunoApi": { "baseUrl": "http://suno-api:3000", "apiKey": "…" },  // or SUNO_API_BASE_URL
  "command": { "path": "/opt/band/generate.sh", "args": [] },
  "songsDir": "/config/band-songs",
  "generateTimeoutMs": 360000,
  "announce": true,
  "introGapMs": 700,
  "keepSongs": 20
}
```

Three generators, because on 2026-09-17 there is no obvious one:

| provider | what it is | state |
| --- | --- | --- |
| `minimax` | MiniMax `POST /v1/music_generation`, model `music-3.0` by default | **Refuses accounts MiniMax does not count as existing paying music customers** (HTTP 410, status 2153, on every model id incl. `-free`). A Coding Plan key that generated music for free in August 2026 is refused in September. |
| `suno-api` | a self-hosted [gcui-art/suno-api](https://github.com/gcui-art/suno-api) (`POST /api/custom_generate`, `wait_audio: true`), which drives a Suno web account | Suno has no official API; this is the open-source answer and needs a Suno account cookie on the suno-api side. |
| `command` | any executable: the song spec as JSON on stdin (`title`, `style`, `styleTags`, `vocals`, `lyrics`, `outDir`, `fileStem`), one JSON line on stdout with `audioPath` or `audioUrl` | the seam for a self-hosted model (MiniMax-Music3, ACE-Step) on the box. |

`styleTags` carries the Suno-shaped prompt with the band-leader vocal in front
when the song has a singer; `style` is the short MiniMax-shaped field.

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

## Installing as a managed plugin (recommended, PHA-3326)

`openclaw plugins install --link <path>` is a real managed install — it
creates an install record in the Gateway's own config/state dir, same as any
other plugin — while loading the code straight from a mounted host directory.
That matters here because `--link` is the one install mode exempt from
OpenClaw's built-runtime-entry check: this plugin ships TypeScript directly
(`openclaw.extensions: ["./index.ts"]`, no `dist/`, matching
`extensions/discord/src/voice`'s bundled-plugin shape, and explicit per
`package.json#openclaw.build.bundledDist: false`), and a plain `install
<path>`, `npm:`, or `npm-pack:` install all require a compiled entry point
this package doesn't have.

**Confirmed empirically against this repo directly (2026-09-07, after the
PHA-3220 split out of plnt-sexton put `openclaw.plugin.json` at repo root):**
`openclaw plugins install git:https://.../openclaw-teamspeak-plugin.git`
fails with the identical built-runtime-entry error as `npm-pack:` did before
the split. Repo-root manifest placement only ever fixed manifest *discovery*
for `git:` installs — it does nothing about the missing `dist/`. Until this
package ships a real build step, `--link` is the only install source that
works for it.

**Confirmed working against OpenClaw 2026.9.2**: the plugin's
`openclaw/plugin-sdk/*` production-private subpath imports (`realtime-voice`,
`config-contracts`, `runtime-env`) resolve correctly from a `--link`-installed
directory that lives entirely outside the Gateway's own image — `openclaw
plugins inspect teamspeak --runtime` reports `"imported": true` after loading
`index.ts` → `src/channel.ts` → the bridge/runtime modules. **This requires
OpenClaw >=2026.9.2** (`package.json#peerDependencies.openclaw`,
`openclaw.plugin.json`'s `compat.pluginApi`); confirmed failing on 2026.7.1,
where OpenClaw refuses the install on a plugin-API compat mismatch before it
gets far enough to hit SDK resolution.

The install itself survives `openclaw update` / a base-image pull: the plugin
code lives in a bind-mounted host directory (not the image), and the install
record lives in the Gateway's persisted config/state dir (also not the
image). Neither is touched by swapping the base image. That is the whole
motivation for this path over the custom Gateway image below, which an image
pull silently wipes. The bind mount itself does need to be a permanent part
of whatever manages the container's lifecycle (compose file, Unraid
template, etc.) — see [`INSTALL-PHATT-RAID.md`](INSTALL-PHATT-RAID.md) for
how that's done for this plugin's one live deployment.

**Live on PHATT-RAID as of 2026-09-09** (PHA-3326): core bumped to
`ghcr.io/openclaw/openclaw:2026.9.3`, plugin `--link`-installed and loading
clean (`"imported": true`), mount persisted in the Unraid container template.
The `channels.teamspeak` config block is a separate, not-yet-done step
(PHA-3220's live-voice verification).

```bash
# On the Gateway host. Stages the plugin, strips the checkout-only test
# scaffolding, and npm-installs its one runtime dependency (ws) using the
# Gateway image's own node/npm (the host itself typically has neither).
./install/stage-teamspeak-link.sh
```

Then, once — these steps touch the running container, so they're manual:

1. Add a permanent bind mount of the staged directory into the Gateway
   container (Unraid: Docker tab → edit the container → add a Path mapping).
2. `openclaw plugins install --link <mounted-path> --force --accept-capabilities`
3. Add the `channels.teamspeak` config block (below) and restart the Gateway.

`openclaw plugins update` does not apply to a `--link` install (there's no
version to move to; it always loads current disk contents) — a plugin change
just needs `stage-teamspeak-link.sh` re-run and the Gateway restarted.

For PHATT-RAID specifically, see [`INSTALL-PHATT-RAID.md`](INSTALL-PHATT-RAID.md)
for the exact commands against that box's layout.

## Building it into the Gateway image (alternative / CI)

The other option is compiling this plugin straight into a custom Gateway
image, which is the more familiar path for a bundled-style extension and
still useful for local dev or a from-scratch CI build. Its downside is
exactly what motivated the section above: a custom image gets silently
replaced by any subsequent `openclaw update` or base-image pull, so it needs
a manual rebuild-and-redeploy after every core upgrade.

Copy this directory into an OpenClaw source checkout as `extensions/teamspeak`,
then build with the plugin selected (`docs/install/docker.md`, "Source-built
images with selected plugins"):

```bash
OPENCLAW_EXTENSIONS=teamspeak docker compose build
```

The build script in [`install/`](install/build-openclaw-teamspeak.sh) does
this end to end.

### Using it in an OpenClaw checkout

Two files are shaped for this standalone repo and should be adjusted on the way
in (both `stage-teamspeak-link.sh` and `build-openclaw-teamspeak.sh` do this
for you):

1. `tsconfig.json` — replace the whole file with
   `{ "extends": "../tsconfig.package-boundary.base.json" }` (checkout build
   only; a `--link` install leaves it alone since nothing runs `tsc` at
   runtime).
2. `test/sdk-stubs/`, `vitest.standalone.config.ts` — delete them. They exist
   only so the plugin can be tested outside a checkout; inside one, or under a
   `--link` install, the real SDK resolves and the repository's own vitest
   runs the tests.

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

The PHA-3228 stt-tts lane adds `test/segmenter.test.ts` (where an utterance
ends, including the hangover that keeps a mid-sentence pause from becoming two
turns), `test/whisper-local.test.ts` (the WAV the sidecar receives, and whisper's
non-speech placeholders never becoming a turn), `test/speech.test.ts` (the
pinned MiniMax model id and fallback staying off) and `test/stt-tts-lane.test.ts`
— replayed speaker frames in, a transcript per speaker, the wake gate at 1 vs 2
humans, TTS bytes on `voice_audio`, and the lane refusing a hosted transcription
provider rather than silently metering.

### What the standalone suite does and does not prove

`test/sdk-stubs/realtime-voice.ts` stands in for the SDK. It is split
deliberately:

- **Faithful** — `resamplePcm` is the real implementation, vendored verbatim
  (`test/sdk-stubs/vendor/audio-codec.ts`, pinned to openclaw@fc1877d7), the
  activation-name matcher likewise (`test/sdk-stubs/vendor/activation-name.ts`,
  same pin, with `levenshteinDistance` inlined), and the wake-name/barge-in
  policy helpers are line-for-line copies. Assertions against these are
  assertions about real shared behavior.
- **Inert** — provider resolution and the session harness are minimal fakes. The
  speaker-session tests inject a fake harness through `deps`, so they cover this
  plugin's wiring, not the provider stack.

Not covered here, and needing a real gateway: the live provider connection, and
`src/channel.ts` / `src/accounts.ts` / `src/bridge/ws-socket.ts` / `src/runtime.ts`,
which import SDK subpaths that are not stubbed and are excluded from the
standalone typecheck. For the stt-tts lane that also means the two host seams it
hangs off — `runtime.agent.runCommandFromIngress` and `runtime.tts.textToSpeech`
— are exercised here only through the structural types in `src/voice/agent-turn.ts`
and `src/voice/speech.ts`, and against fakes.

`src/channel.ts` is the one to read before a deploy, because it is both
unverifiable here and the file that decides whether anything runs at all: its
`gateway.startAccount` is the gateway's only lifecycle seam for a channel
account. It resolves the agent route, reads the bootstrap context files, starts
one voice runtime, and stays pending until the account is aborted. The first
thing `OPENCLAW_EXTENSIONS=teamspeak docker compose build` proves is that this
file compiles against the real SDK.
