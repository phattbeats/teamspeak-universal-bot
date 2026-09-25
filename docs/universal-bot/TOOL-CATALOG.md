# Universal TeamSpeak Bot — research notes and tool catalog

PHA-3783, 2026-09-24. Brandon's ask: one universal TeamSpeak bot platform
that Sexton and Bexton become instances of, with a real tool catalog
(queue, moderation, channel movement, web search, skills, persona editing,
token control) and pluggable STT.

## 1. What we already have (measured, not assumed)

| Layer | Where | State |
| --- | --- | --- |
| TS client + audio + text | `sexton/` (Rust, tsclientlib) | one connection per bot, PCM in/out, music lane, `BridgeCommand` over a Unix socket |
| OpenClaw channel plugin | `teamspeak-plugin/` (TS) | STT→agent→TTS lane, wake gate, 12 agent tools, text commands |
| STT | whisper.cpp pool container + MiniMax ASR fallback | already a provider switch (`sttProvider=whisper-local\|minimax`) |
| TTS | MiniMax T2A (streaming) | per-bot `voiceId` |
| Personas | `image/bexton/workspace/*.md` | Bexton versioned; **Sexton is NOT** (see §5) |

Existing agent tools (`teamspeak-plugin/src/tools/registry.ts`):
`play_music`, `stop_music`, `set_volume`, `what_did_i_miss`, `who_is_here`,
`poke`, `leave_voice`, `join_voice`, `compose_song`, `band_status`,
`song_lyrics`, `replay_song`.

Existing text commands (`src/voice/commands.ts`): `status`, `join <channel>`,
`leave`, `mute`. So the bot can already move channels via
`BridgeCommand::Join` — it just is not exposed to the model as a tool, which
is why "SextonProbe couldn't see the other channels".

Voice turns run through `runtime.agent.runCommandFromIngress`, i.e. the
**full OpenClaw agent**. Core tools (web_search, web_fetch, skills, memory)
are available to it subject to `tools.allow/deny`. Sexton's live config
denies only `process` and `sessions_spawn`, but no web-search provider is
configured, so `web_search` is dead weight until one is.

Latency today (2026-09-24 23:40 UTC, Sexton, MiniMax-M3):
`sttMs=2039 agentMs=7461 ttsMs=4950 firstAudioMs=14508`. The agent step is
half of it. Token/turn control (§4.6) is also a latency fix.

## 2. Prior art (is this like Discord bots? has anyone done it?)

- **Discord**: yes, same shape. discord.js / discord.py = gateway events +
  command registry + voice receive. The common LLM voice bot pattern is
  exactly ours (whisper STT → LLM → TTS): e.g.
  KickerMix/Discord-Local-LLM-VoiceChat-Bot, Eidenz/Discord-VC-LLM,
  hc20k/LLMChat. OpenClaw's own Discord plugin exposes messaging, channel
  admin (create/edit/delete), roles, moderation (timeout/kick/ban), polls,
  pins, search, member/role/channel info, voice status — behind a
  per-action allowlist. That allowlist is the model for our catalog.
- **TeamSpeak, non-LLM**: TS3AudioBot (Splamy, C#, `!command` + HTTP API,
  rights.toml permissions, plugin modules; last release 0.12.0 in 2021),
  SinusBot (closed source, scripts), ts3-nodejs-library (ServerQuery only,
  no voice), tsclientlib (what we use; full client incl. voice).
- **TeamSpeak, LLM voice**: nothing found on GitHub for 2024-2026. Our
  stack appears to be the first working one. Nothing to reuse; we keep
  building.
- **TS6 server admin surface**: TS6 dropped raw ServerQuery (10011). What
  remains is SSH query (10022) and HTTP **WebQuery** (10080, `x-api-key`
  header, swagger at `:10080/swagger`, API keys scoped per permission).
  Our `teamspeak6-server` container maps 10080 (host 32769) but the port
  **refuses connections** from both the Docker network and the host, so
  WebQuery is not enabled on the server today. Alternative that needs no
  server change: a full client (tsclientlib) in a server group with the
  permissions can send `clientkick`, `banclient`, `clientmove`,
  `channeledit`, `serveredit` itself — this is how TS3AudioBot moderates.

## 3. Architecture for the universal bot

One image, N instances. Each instance = `persona pack` + `openclaw.json`
overlay + TS identity. Everything else identical.

```
teamspeak-bot/
  core/            Rust client (today: sexton/), BridgeCommand grows moderation
  plugin/          OpenClaw channel plugin (today: teamspeak-plugin/)
  tools/           one file per tool group, each with its own allowlist key
  stt/             provider contract: whisper-local | minimax | <next>
  personas/
    sexton/  SOUL.md AGENTS.md IDENTITY.md voice.json tools.json
    bexton/  ...
  image/           build + deploy, persona chosen by env PERSONA=sexton
```

Tool groups are enabled per persona in config, Discord-plugin style:

```json5
channels.teamspeak.tools: {
  music: { enabled: true, queue: true, sources: ["youtube","soundcloud","local","suno"] },
  channel: { enabled: true, move: true },
  moderation: { enabled: true, kick: true, ban: false, edit: false, allowGroups: ["Server Admin"] },
  persona: { enabled: true, edit: false },
  web: { search: true, fetch: true },
  skills: ["clawhub", "weather", ...],
}
```

## 4. Tool catalog

Status: **have** = live today, **plumbed** = command exists in Rust/bridge,
needs an agent tool, **new** = build.

### 4.1 Channel and presence
| Tool | Status | Notes |
| --- | --- | --- |
| `who_is_here` | have | current channel only |
| `list_channels` | new | channels **with occupants** — the "probe couldn't see anyone" fix. `Snapshot` already has the tree. |
| `move_to_channel` | plumbed | `BridgeCommand::Join`; text `join` exists. Add tool + "follow <person>" |
| `where_is` | new | which channel a nickname is in |
| `poke` | have | |
| `send_text` | plumbed | `BridgeCommand::SendText` (channel/server/client) |
| `leave_voice` / `join_voice` | have | |

### 4.2 Music queue (PHA-3635 gave us a queue the bot can't see)

PHA-3785 shipped the "new" rows below against the existing `MusicPlayer`
queue (`teamspeak-plugin/src/tools/music.ts`) — no second queue, same
`ActiveStream`/`queue` the pacing-rules comment at the top of the file
already documents. Tool defs and dispatch: `teamspeak-plugin/src/tools/registry.ts`;
tests: `teamspeak-plugin/test/music.test.ts` and `test/tools.test.ts`.

| Tool | Status | Notes |
| --- | --- | --- |
| `play_music` | have | queues when busy |
| `stop_music`, `set_volume` | have | |
| `now_playing` | have | title, requester, elapsed, paused |
| `show_queue` | have | numbered list, requester per entry |
| `skip` | have | next in queue — **distinct from `stop_music`/`clear_queue`**, see below |
| `remove_from_queue` | have | by id (from `show_queue`) |
| `move_in_queue` | have | reorder by id to a new 1-based position |
| `clear_queue` | have | |
| `search_music` | have | return top-N candidates so the model can ask "which one"; **never plays anything itself** |
| `play_source` | have | explicit source: youtube, soundcloud, bandcamp, direct URL, local; **band-library is not backed yet, see notes** |
| `seek`, `pause`/`resume` | have | ffmpeg lane supports it via reseek (`seek`) or wall-clock freeze (`pause`/`resume`) |

#### 4.2.1 `skip` vs `stop_music` vs `clear_queue`

Three different operations that are easy to conflate:
- **`stop_music`** stops the current track *and clears the queue*. This is
  "get out" — a deliberate reset, not a skip.
- **`skip`** tears down only the current track and, if something is queued,
  starts it. The rest of the queue is left alone. If nothing is queued it
  behaves like `stop_music` (nothing left to advance to).
- **`clear_queue`** empties the queue only; whatever is currently playing is
  untouched. The inverse case of `skip` — it drops what's *waiting*, not
  what's *playing*.

#### 4.2.2 Per-tool detail

| Tool | Params | Returns | Notes |
| --- | --- | --- | --- |
| `now_playing` | none | `{ playing, title?, source?, requestedBy?, elapsedMs?, paused? }` | `playing:false` when nothing is loaded |
| `show_queue` | none | `{ count, queue: [{ position, id, title, requestedBy }] }` | read-only; never starts or changes playback |
| `skip` | none | `{ skipped, nowPlaying?, remaining }` on success; `ok:false` if nothing is playing | does not clear the rest of the queue |
| `remove_from_queue` | `id` (string, from `show_queue`) | `{ removed, remaining }` | `ok:false` for an unknown id |
| `move_in_queue` | `id` (string), `position` (number, 1-based) | `{ queue: [{ position, id, title }] }` | clamps out-of-range positions to the ends of the queue |
| `clear_queue` | none | `{ cleared }` (count removed) | current track keeps playing |
| `search_music` | `query` (string), `limit` (number, optional, default 5, max 10) | `{ count, candidates: [{ title, id, url, durationSeconds?, channel? }] }` | a read-only `yt-dlp` `ytsearchN:` lookup; **never plays anything** — results come back as one structured batch, not narrated as separate chat/voice lines |
| `play_source` | `source` (`youtube`\|`soundcloud`\|`bandcamp`\|`direct-url`\|`local`\|`band-library`), plus `query`/`url`/`file` as the source needs | `{ title, source }` or `{ queued, position, title, source }` | `bandcamp` has no yt-dlp search extractor and requires a direct URL; `band-library` currently has **no backing catalog** in this repo and fails with a clear "not available" error rather than fabricating a listing (scope omission, see PHA-3785 report) |
| `pause` | none | `{ paused }` | `ok:false` if nothing is playing or it's already paused |
| `resume` | none | `{ resumed }` | `ok:false` if nothing is paused |
| `seek` | `seconds` (number, >= 0) | `{ title, seconds }` | restarts ffmpeg with `-ss` on the same resolved stream; `ok:false` if nothing is playing |

### 4.3 Moderation (gated: only on request from an allowed server group)
| Tool | Status | Path |
| --- | --- | --- |
| `kick_from_channel` | new | tsclientlib `clientkick` reasonid=4 |
| `kick_from_server` | new | `clientkick` reasonid=5 |
| `ban` (duration, reason) | new | `banclient` |
| `unban`, `list_bans` | new | `bandel`, `banlist` |
| `move_client` | new | `clientmove` (others, not self) |
| `mute_client` / server-mute | new | `clientedit`/permission |
| `channel_create/edit/delete` | new | `channeledit` etc. (PHA-3424: description edits ping everyone; keep off by default) |
| `server_edit` (name, welcome, max clients) | new | `serveredit` |
| `set_server_group` | new | `servergroupaddclient` |
| `whoami_permissions` | new | so the bot can say "I'm not allowed to" instead of failing |

Prerequisites: bot identity needs a server group with those permissions
(`[Brandon/host]` step), an `allowGroups` config, and an audit line in the
chat log for every mod action. Second path if we want it later: enable TS6
WebQuery and hand the bot an API key.

### 4.4 Persona
| Tool | Status | Notes |
| --- | --- | --- |
| `show_persona` | new | reads SOUL/IDENTITY summary |
| `edit_persona` | new | append/replace a rule in SOUL.md, announce it in channel (SOUL already demands that) |
| `set_voice` | new | swap MiniMax voiceId/speed live |
| `set_wake_names` | new | runtime setter API exists (`runtime-setter-api.ts`) |
| `set_follow_up_window` | new | `followUpSilenceMs` live |

### 4.5 Web and skills (OpenClaw core, just needs enabling)
| Tool | Status | Notes |
| --- | --- | --- |
| `web_search` | have-but-dead | needs `tools.web.search.provider` + a key (Brave/MiniMax/Gemini…) or a key-free one (DuckDuckGo/SearXNG); add to `tools.allow` |
| `web_fetch` | have | |
| skills | have | 17/53 ready on the Sexton gateway; pick a per-persona list (weather, clawhub, browser-automation…) and prune the rest so they don't eat prompt budget |
| `memory`/notes | have | daily memory already writes |

### 4.6 Token and turn control ("every token end to end per instruction")
Not a tool, a config surface plus a log line:
- per-turn `maxOutputTokens` for voice (30-word answers do not need 1k)
- prompt budget: which of SOUL/AGENTS/USER/skills/memory get loaded on a
  voice turn vs a text turn
- transcript framing size (`agent-turn.ts` wraps every utterance)
- `thinkingDefault` per persona (already `off` on Sexton)
- one log line per turn: prompt tokens, output tokens, model, cost, and
  the existing `sttMs/agentMs/ttsMs`. Then we can see what each
  instruction costs and cut it.

### 4.7 STT as a connector
`sttProvider` is already a switch. Make it a contract:
`transcribe(pcm, {lang, prompt}) -> {text, confidence?, ms}` with
`whisper-local` (pool container), `minimax`, and room for a hosted one.
Config per persona; no code change to swap.

## 5. Things found on the way

- **Sexton has no persona.** Live `SOUL.md`, `IDENTITY.md`, `USER.md` are
  the stock OpenClaw placeholders ("_Fill this in during your first
  conversation_"). Bexton's are real. That, plus the stock AGENTS.md's
  "you are a guest / ask first" tone, is the "stuck up, not human" problem.
  Fix = write Sexton's persona, version it next to Bexton's, and share a
  `HUMAN.md` block both load (contractions, short, no hedging, disagree,
  swear when it lands, never "I'd be happy to").
- **Follow-up window was off entirely** (default 0, neither bot set it).
  Fixed in PR #24 (default 15 s of dead air after the bot finishes
  speaking) and hot-patched live on both bots the same night.
- **Bexton container is stopped** (SIGTERM 2026-09-23 00:37, exit 0) and
  was not restarted.
- The probe binary (`probe-channels`) lists channels but not clients; the
  bot's own `Snapshot` does have both.
