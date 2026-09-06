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
          "bootstrapContextFiles": ["IDENTITY.md", "USER.md", "SOUL.md"],
          "bargeIn": true,
          "minBargeInAudioEndMs": 250,
          "toolPolicy": "owner",
          "consultPolicy": "always"
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
- `!sexton status` — bridge/channel/session/wake-name/barge-in state

Text that is not addressed to us — including another bot's `!roll` — draws no
reply.

## Realtime tools

Tools are registered through the harness `tools` list, and calls come back on
`onToolCall` → `submitToolResult` — the same path Discord uses for
`openclaw_agent_consult`. Pass a `toolRegistration` to
`TeamSpeakRealtimeSpeakerSession`. The tools themselves are **PHA-3176**; until
then an unregistered call is answered with an error rather than left pending,
because the provider blocks its turn until every outstanding call settles.

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
