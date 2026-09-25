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
| Tool | Status | Notes |
| --- | --- | --- |
| `play_music` | have | queues when busy |
| `stop_music`, `set_volume` | have | |
| `now_playing` | new | title, requester, position, remaining |
| `show_queue` | new | numbered list, requester per entry |
| `skip` | new | next in queue (today `stop` drops the whole queue) |
| `remove_from_queue` | new | by position or "mine" |
| `move_in_queue` | new | reorder; "play Kai's next" |
| `clear_queue` | new | |
| `search_music` | new | return top-N candidates so the model can ask "which one"; today `ytsearch1:` picks blind |
| `play_source` | new | explicit source: youtube, soundcloud, bandcamp, direct URL, local library, **Suno/band library** (`replay_song` already covers band) |
| `seek`, `pause`/`resume` | new | ffmpeg lane supports it |

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

Checked each item against the actual `AgentCommandOpts` / `AgentCommandIngressOpts`
surface (`openclaw/src/agents/command/types.ts`) that `runCommandFromIngress`
accepts, not the wishlist. Two of five items are a real, ingress-exposed knob;
three are not there and would need a host change. Cut accordingly.

| Item | Status | Notes |
| --- | --- | --- |
| `voice.thinking` (per-turn `thinking`) | **shipped this issue** | `AgentCommandOpts.thinking` is a real, unrestricted ingress field. Wired: `config.ts` (`TeamSpeakVoiceConfig.thinking`) → `stt-tts-lane.ts` → `agent-turn.ts` → `runCommandFromIngress({ thinking })`, defaulting to `"off"` for every stt-tts voice turn regardless of the agent's `thinkingDefault`. This is the one lever in this list that plausibly moves `agentMs` (7461ms measured 2026-09-24 on MiniMax-M3) — a visible thinking trace has nowhere to go on a voice line and the model still pays to produce it. Not yet re-measured live; do that before trusting the number. |
| per-turn `maxOutputTokens` | **cut — not exposed** | `AgentCommandOpts` has no `maxOutputTokens` field. The host resolves it internally per model/context-engine (`embedded-agent-runner/run-loop.ts`, tied to the model's declared `maxTokens`), not per ingress call. Capping a 30-word voice answer at ~150 output tokens would need a new `AgentCommandOpts` field plumbed through the embedded runner — an `openclaw` core change, out of scope for this plugin. Filed nowhere yet; worth a core issue if the token spend turns out to matter once the log line below has data. |
| prompt budget (which of SOUL/AGENTS/USER/skills/memory load per turn) | **cut — wrong model** | This isn't a per-turn switch. Workspace bootstrap files (`IDENTITY.md`/`USER.md`/`SOUL.md`) load once per session via `bootstrapPending` (`openclaw/src/agents/bootstrap-mode.ts`), not fresh on every voice turn; skills/memory inclusion is system-prompt composition, same for every channel today. The closest real knob is `promptMode: "minimal"` (`system-prompt.ts`), but that's built for spawned subagents (trims tool guidance/owner line, not SOUL/skills) and swapping it in for voice is untested and risks silently changing tool availability. Not worth the risk for an unmeasured saving — leave it. |
| transcript framing size (`agent-turn.ts`) | **cut — already minimal** | `formatTeamSpeakVoicePrompt` is one line: `` `[teamspeak voice] ${nickname} said: ${message}` ``. That's a handful of tokens of fixed overhead, not a growing cost. Nothing to trim. |
| one log line: prompt/output tokens, model, cost | **shipped, partial** | Extended the existing `teamspeak voice: stt-tts turn` line (`stt-tts-speaker-session.ts`) with `requestedModel=` / `requestedThinking=`, next to the existing `sttMs/agentMs/ttsMs/firstAudioMs`. Prompt tokens, output tokens, and cost are **not there and can't be added from this repo**: `runCommandFromIngress` returns only `{ payloads }` to the ingress caller (`command/types.ts`) — no usage object crosses that boundary, even though the host tracks it internally (`CliUsage` in `cli-output-records.ts`, promptTokens/outputTokens/cost). Getting real numbers into this log line needs `runCommandFromIngress` to return usage on the result, which is a host (openclaw core) change, not a plnt-sexton one. |

**Bottom line:** of the five asks, two were real, ingress-level, plugin-side
work and are done. The other three either don't exist as a per-call knob today
(`maxOutputTokens`, prompt/token/cost in the ingress result) or don't map to
the mechanism the issue assumed (prompt budget). Recommend a follow-up host
issue against `openclaw` core for `maxOutputTokens` override + usage-on-result
if the `requestedModel`/`requestedThinking` log line, once it has a few days
of live data, shows spend that's worth capping rather than just watching.

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
