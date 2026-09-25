# Bring your own OpenClaw (PHA-3798)

For someone who already runs an OpenClaw gateway and wants to attach it to a TeamSpeak
server — not Sexton/Bexton's all-in-one deploy (`image/`, PHA-3428), which bakes in a
specific persona, whisper pool, and music stack for one operator's box.

## Architecture

```
your OpenClaw gateway  <--WebSocket-->  plnt-ts-bridge container  <--TS6 protocol-->  the TeamSpeak server
   (teamspeak channel                    (this repo's sexton/,
    plugin, this repo's                   published standalone)
    teamspeak-plugin/)
```

Two pieces, both from this repo, both independent of Sexton/Bexton's own deployment:

1. **The channel plugin** (`teamspeak-plugin/`, package `@openclaw/teamspeak`) — runs
   inside *your* gateway process. STT → agent turn → TTS, wake-word gating, text
   commands, and the agent tool catalog (`docs/universal-bot/TOOL-CATALOG.md`).
2. **The bridge** (`sexton/`, published as `ghcr.io/phattbeats/plnt-ts-bridge`) — the
   actual TeamSpeak client. A separate container; your gateway never speaks the TS6
   protocol directly, only WebSocket to this.

## Status of this doc

**Not yet run end to end by anyone outside this repo.** Each piece below has been
verified independently (plugin typecheck/tests, plugin CI-verified build, bridge image
CI-verified build and env wiring) but no one has taken a stock
`ghcr.io/openclaw/openclaw` container plus this compose file plus this doc and joined a
real TS6 server with it, which is the actual DoD (PHA-3798, PHA-3783). Treat the exact
commands below as accurate to the code as of this writing and expect to find rough edges
Tyler-testing them.

## 1. The bridge

Pull `ghcr.io/phattbeats/plnt-ts-bridge:latest` (published by `.github/workflows/sexton.yml`'s
`publish-ts-bridge` job on every push to `main`) and run it against your TS6 server:

```yaml
services:
  ts-bridge:
    image: ghcr.io/phattbeats/plnt-ts-bridge:latest
    restart: unless-stopped
    environment:
      TS_BRIDGE_ADDRESS: your-teamspeak-server.example.com
      TS_BRIDGE_PORT: "9987"
      TS_BRIDGE_CHANNEL: "General"
      TS_BRIDGE_NICKNAME: "MyBot"
      TS_BRIDGE_IDENTITY_FILE: /data/identity.txt
    volumes:
      - ts-bridge-data:/data
    expose:
      - "9099"   # the WebSocket the plugin talks to — never publish this to the host

volumes:
  ts-bridge-data:
```

First boot has no identity yet: the bridge mints one and logs it once
(`identity=<counter>V<key>`, at warn level — `docker compose logs ts-bridge`). Copy that
exact string into the file at `TS_BRIDGE_IDENTITY_FILE` (on the `ts-bridge-data` volume)
before the *next* restart, or the bot gets a new TeamSpeak identity — and drops any
server-group membership you granted it — every time the container recreates. See
`sexton/README.md`'s "Standalone / bring-your-own-OpenClaw" section for the full env var
table (server address, port, public-fallback, channel password, avatar, log dir,
catch-up suppression, WS bind, duck gain).

If your OpenClaw gateway and the bridge are not on the same Docker network, connecting by
container name (`ts-bridge`) won't resolve — put them on one `docker network` or expose
`:9099` to wherever the gateway actually runs, still never to the open internet.

## 2. The plugin

**This is the part that is genuinely still in flight.** Three ways to get
`@openclaw/teamspeak` into your gateway, roughly best-to-worst for a real stranger:

- **`npm:@openclaw/teamspeak`** — not published to the npm registry yet. This is the
  intended end state (PHA-3798 item 1's preferred fix) and needs someone with npm
  publish rights for the `@openclaw` scope (or a rename to an unscoped package name) to
  actually run `npm publish` from `teamspeak-plugin/` — a `[Brandon/host]` step, not
  something done in this pass. Once published, `openclaw plugins install
  npm:@openclaw/teamspeak` should work: this repo's `teamspeak-plugin/dist/` (committed,
  CI-checked not to drift from `src/`) satisfies the compiled-entry requirement that
  blocked this before PHA-3798, and OpenClaw resolves the plugin's `openclaw/plugin-sdk/*`
  imports against your gateway's own installed `openclaw` package automatically for any
  install kind that declares `openclaw` as a dependency — this package already does
  (`peerDependencies.openclaw`).
- **`npm-pack:<path-to-tgz>`** — works today without any registry, and does not need
  GitHub access to this (private) repo at install time — only whoever builds the tarball
  needs that. From a checkout of this repo:
  ```bash
  cd teamspeak-plugin
  npm ci
  npm pack   # -> openclaw-teamspeak-0.1.0.tgz
  ```
  Copy that `.tgz` to wherever your gateway runs and
  `openclaw plugins install npm-pack:./openclaw-teamspeak-0.1.0.tgz`. **Not yet
  confirmed against a real gateway** — see README's PHA-3798 section.
- **`--link`** — the proven path (this is how Sexton/Bexton's own gateway loads it,
  PHA-3326), but it means staging the plugin directory onto your box and does not need
  `dist/` at all. Same private-repo caveat as above: you need a checkout of this repo,
  which today means either being handed one or getting repo access — `plnt-sexton` is
  private. See `teamspeak-plugin/INSTALL-PHATT-RAID.md` for the exact staging recipe (it
  is written against our own box, but the `stage-teamspeak-link.sh` step is generic).

**The private-repo problem is real and unsolved by this pass.** Whichever install kind
you use, someone still has to hand a stranger either a checkout or a built tarball of a
private repo. The `npm:` path is the only one of the three that actually removes that
dependency — until it's published, "self-service" BYO is really "ask phattbeats for a
`.tgz`."

Minimal `openclaw.json` channel config once the plugin is installed:

```json5
{
  "channels": {
    "teamspeak": {
      "bridgeUrl": "ws://ts-bridge:9099",
      "channel": "General",
      // PHA-3798 item 5 — see "Security defaults" below before changing any of these.
      "commandAllowFrom": [],
      "voice": {
        "enabled": true,
        // "stt-tts" is the local-whisper-only lane (src/config.ts refuses any
        // hosted/metered transcription provider under this mode) — the $0-ceiling
        // promise this repo makes for its own bots. "agent-proxy" (the default) is a
        // hosted realtime voice provider (OpenAI/etc.) instead and costs real money
        // per conversation; only pick it if that's actually what you want.
        "mode": "stt-tts",
        "wakeNames": ["MyBot"]
      },
      "tools": {
        "music": { "enabled": false },
        "moderation": { "kick": false, "ban": false, "edit": false }
      }
    }
  }
}
```

Bind it to an agent the same way any other channel is bound (`agents.json` /
`--agent`); nothing about the teamspeak channel plugin is special there.

## 3. STT and TTS

Both are your problem to pay for and configure — nothing here is free beyond your own
compute. What already exists as of PHA-3798 (a clean provider *contract* is PHA-3790,
in progress; this is what config knobs exist today):

- **STT**: `src/voice/stt-routing.ts` runs a local `whisper.cpp` server as primary and
  can escalate to MiniMax `asr-1.0` (`src/voice/minimax-asr.ts`) on long-or-empty
  segments. You need *a* whisper.cpp server reachable over HTTP
  (`http://<host>:<port>/inference`) — nothing in this repo runs one for you outside the
  all-in-one Sexton/Bexton image (`whisper/`, a separate container in this repo you
  could also run standalone, or any other whisper.cpp-compatible endpoint). Point the
  plugin at it with `channels.teamspeak.voice.streaming.transcription.url` (or the
  `TEAMSPEAK_WHISPER_URL` env var; default `http://whisper:8080/inference` either way
  — `src/config.ts`, `resolveTeamSpeakTranscriptionConfig`). This field name has moved
  before (it used to be a top-level flag) and PHA-3790's provider-contract work may move
  it again — check `src/config.ts` if this doc drifts.
- **TTS**: MiniMax T2A is the only wired provider today (`voiceId` config, own API key).

If neither works for you, the agent tools and text-command lane still function —
voice specifically won't.

## 4. Security defaults for a stranger's server (PHA-3798 item 5)

None of these are enforced by the plugin — they are config you must set, and the example
above already sets them. Getting them wrong on someone else's TeamSpeak server is the
actual risk this section exists to head off:

- **`commandAllowFrom: []`, not unset.** `unset` means *anyone in the channel* can issue
  `!` text commands (`src/config.ts`'s own doc comment: "Unset allows anyone in the
  channel") — that's fine for Sexton's own semi-trusted channel, it is very much not
  fine as a stranger's-server default. An **empty array**, not omitting the key, is what
  actually locks it down: `params.allowFrom && !params.allowFrom.includes(clientId)`
  (`src/voice/commands.ts`) — `[]` is truthy in JS, so `[].includes(anything)` is always
  false and every command is rejected. Add specific TeamSpeak client ids once you know
  who should have access.
- **Moderation tools already fail closed** (`src/tools/registry.ts`,
  `docs/universal-bot/TOOL-CATALOG.md` §4.3) — an empty or absent `moderation.allowGroups`
  disables every kick/ban/edit tool regardless of the `kick`/`ban`/`edit` flags, no
  action needed beyond not setting `allowGroups`. If you do want moderation, the bot's
  own TeamSpeak identity also needs the underlying server permission (a real TS server
  group) — see TOOL-CATALOG.md's prerequisite note; granting the config `allowGroups`
  without that just gets you `ModerationResult { ok: false }`.
- **Music defaults to enabled** (`tools.music.enabled` defaults `true`) — it shells out
  to `yt-dlp`/`ffmpeg`, not arbitrary commands, but it's still unrequested external
  network activity on someone else's server. The example config above turns it off;
  turn it back on deliberately once you've decided you want it.
- **The band/song-generation tools (`compose_song` etc.) already default off** in
  practice: they need an explicit `SEXTON_BAND_ENABLED`-equivalent provider
  configuration (MiniMax music, a self-hosted `suno-api`, or a custom `command`) to do
  anything at all — with none of that configured the band lane logs why it refuses to
  start and the rest of the bot comes up regardless (`image/README.md`, "The generator
  is the open question"). Nothing to turn off for a BYO deploy that doesn't set it up.

## 5. TeamSpeak server-group permissions

If you want moderation tools live (not just configured — see above), the bot's TS
identity needs an actual server group with kick/ban/move/edit permissions, same recipe
as Sexton/Bexton (`docs/universal-bot/TOOL-CATALOG.md` §4.3, PHA-3793):

1. Create a TeamSpeak server group (or reuse an existing admin-ish one) carrying the
   permissions the moderation tools need: `b_client_kick_from_channel`,
   `b_client_kick_from_server`, `b_client_ban_client`, `i_client_kick_power`,
   `i_client_ban_power` (>= whoever you want kickable/bannable), `b_channel_create_...`,
   `b_channel_modify_...`, `b_virtualserver_modify_...` as needed for `edit_channel`/
   `edit_server`.
2. Add the bot's TeamSpeak account to that group (`servergroupaddclient`, or the
   `add_to_server_group` tool once it already has *some* moderation access to call
   itself with, or your server's own admin UI the first time).
3. Set `tools.moderation.allowGroups` in `openclaw.json` to the name(s) of the TeamSpeak
   server group(s) whose *members* (not the bot — the people talking to it) are allowed
   to invoke moderation tools. This is a different group than step 1: step 1 is what the
   bot itself can do on the server; `allowGroups` is who can ask it to.

Without step 1 the tools run and report `ok: false`. Without step 3 they don't register
at all (fails closed).

## Open items after this pass

- Publish `@openclaw/teamspeak` to the npm registry — `[Brandon/host]`, needs npm
  publish rights for the `@openclaw` scope (or an unscoped rename).
- Live-verify `npm-pack:`/`git:` installs against a real, non-production gateway.
- PHA-3790's STT provider contract will likely rename/move the config fields §3 points
  at — revisit this doc once that lands.
- Decide whether `plnt-sexton` (private) is acceptable as the plugin's permanent home
  for a true self-service BYO story, or whether the plugin needs a public mirror
  independent of the npm-registry publish above.
