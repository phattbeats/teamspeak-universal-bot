# Universal TeamSpeak Bot — research notes and tool catalog

#3783, 2026-09-24. Brandon's ask: one universal TeamSpeak bot platform
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
| Personas | `personas/<name>/*.md` | Both versioned (#3791 landed the persona-pack layout below; see §5) |

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

**Shipped (#3791, 2026-09-25):** the `personas/` layout below — one
directory per bot holding its versioned SOUL/AGENTS/IDENTITY(/USER).md,
avatar, `voice.json` (wake names/aliases/excludes, TTS voice id) and
`tools.json` (`music`/`moderation`/`band` gates), sourced by
`image/Dockerfile` and consumed as first-boot defaults by
`image/run-gateway.sh`, with `image/deploy.sh` picking the persona via
`PERSONA=<name>` (one script now serves both bots; `image/deploy-bexton.sh`
shrank to `PERSONA=bexton` plus the couple of knobs — whisper thread count,
credential-import source — that still have no sensible env-free default).
`core/`, `plugin/`, `tools/`, `stt/` below remain the target shape, not yet
reality: those stay `sexton/`, `teamspeak-plugin/` and no separate `tools/`
or `stt/` tree exists.

```
teamspeak-bot/
  core/            Rust client (today: sexton/), BridgeCommand grows moderation
  plugin/          OpenClaw channel plugin (today: teamspeak-plugin/)
  tools/           one file per tool group, each with its own allowlist key
  stt/             provider contract: whisper-local | minimax | <next>
  personas/                                                        [SHIPPED]
    sexton/  SOUL.md AGENTS.md IDENTITY.md USER.md avatar.png voice.json tools.json
    bexton/  SOUL.md AGENTS.md IDENTITY.md          avatar.png voice.json tools.json
    HUMAN.md   (shared, copied into both persona workspaces at build time)
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

### 4.2 Music queue (#3635 gave us a queue the bot can't see)

#3785 shipped the "new" rows below against the existing `MusicPlayer`
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
| `play_source` | `source` (`youtube`\|`soundcloud`\|`bandcamp`\|`direct-url`\|`local`\|`band-library`), plus `query`/`url`/`file` as the source needs | `{ title, source }` or `{ queued, position, title, source }` | `bandcamp` has no yt-dlp search extractor and requires a direct URL; `band-library` currently has **no backing catalog** in this repo and fails with a clear "not available" error rather than fabricating a listing (scope omission, see #3785 report) |
| `pause` | none | `{ paused }` | `ok:false` if nothing is playing or it's already paused |
| `resume` | none | `{ resumed }` | `ok:false` if nothing is paused |
| `seek` | `seconds` (number, >= 0) | `{ title, seconds }` | restarts ffmpeg with `-ss` on the same resolved stream; `ok:false` if nothing is playing |

### 4.3 Moderation (#3786 — gated: only on request from an allowed server group)

Status: **have**, Path A (tsclientlib, no server change). `bridge-proto`'s
`BridgeCommand` grew 11 moderation variants; `sexton/src/main.rs` executes
them against the live `tsclientlib::Connection` and answers every one with a
`BridgeEvent::ModerationResult { action, ok, detail }` (wire type `0x07`, see
`sexton/PROTOCOL.md`). `RosterEntry` grew a `serverGroups: string[]` field so
the plugin can see group membership without a second round trip.

| Tool | Params | Config gate | Notes |
| --- | --- | --- | --- |
| `kick_client` | `nickname`, `fromServer?` (default false), `reason?` | `moderation.kick` | `fromServer=false` kicks from the channel only |
| `move_client` | `nickname`, `channelId` (numeric) | `moderation.kick` | Moves someone else, unlike `move_to_channel` (§4.1) which moves the bot itself. No channel-name lookup yet — needs a numeric id (see §4.1's `list_channels` for how to get one once it lands) |
| `ban_client` | `nickname`, `durationSecs?`, `reason?` | `moderation.ban` | No `durationSecs` = permanent |
| `unban_client` | `banId` | `moderation.ban` | `banId` comes from `list_bans` |
| `list_bans` | none | `moderation.ban` | Requests the server's ban list, but the response is **not parsed back** into the conversation — there is no ban-list notify-event listener wired up yet. The tool reports the request was sent, not the contents |
| `mute_client` | `nickname`, `muted` | `moderation.edit` | Implemented via **talk-power revocation** (`OutClientEditMessage`'s `talk_power_granted`), not a literal server-side voice mute — TeamSpeak's ServerQuery API has no such command. The target visibly loses/regains permission to talk |
| `edit_channel` | `channelId`, `name?`, `topic?` | `moderation.edit` | Numeric id only |
| `create_channel` | `name`, `parentId?` | `moderation.edit` | |
| `delete_channel` | `channelId`, `force?` (default false) | `moderation.edit` | `force=true` deletes even with clients still inside |
| `edit_server` | `name?`, `welcomeMessage?` | `moderation.edit` | Only these two fields are exposed; `OutServerEditPart` has 43, the rest stay untouched |
| `add_to_server_group` | `nickname`, `serverGroupId` (numeric) | `moderation.edit` | Sexton resolves the target's `ClientDbId` server-side before sending `servergroupaddclient` |

**Authorization** (`tools.moderation` in `openclaw.json`):

```json5
channels.teamspeak.tools.moderation: {
  kick: true,
  ban: false,
  edit: false,
  allowGroups: ["Server Admin"],
}
```

**#3791 gave this a declarative home**: `personas/<name>/tools.json`'s
`moderation` block is applied as the fresh-deploy default by
`image/run-gateway.sh` (first boot only, same as everything else in that
step). Both `personas/sexton/tools.json` and `personas/bexton/tools.json`
ship the fail-closed default shown above with everything off and
`allowGroups: []`, matching the fact that no script had ever set this before
— it does not touch or overwrite the live moderation grants already applied
by hand on the running sexton/bexton containers (#3793/#3797); wiring
per-persona live permissions into the persona pack is follow-up work.

- `kick`/`ban`/`edit` gate which tool *groups* get registered at all (per the
  table above).
- `allowGroups` gates *who* may invoke any registered moderation tool: the
  invoking client's `RosterEntry.serverGroups` must contain one of these
  names (case-insensitive). This is checked twice — once to decide whether
  to register the tools, once again per call, since registration only proves
  *some* group is configured, not that *this particular caller* is in it.
- **Fails closed**: an empty or absent `allowGroups` disables every
  moderation tool regardless of the `kick`/`ban`/`edit` flags, because there
  would be nobody it is safe to run them for.
- The Sexton's Rust bridge itself does **no** authorization — it executes
  whatever `BridgeCommand` it's given, same trust model as the existing
  `poke`/`send_text` commands (the plugin is the bridge's only caller). All
  enforcement lives in `teamspeak-plugin/src/tools/registry.ts`.
- Every successful moderation call sends an audit line to the channel via
  the existing `send_text` bridge command (`[moderation] <caller>: <action>
  ...`) rather than inventing a new logging path — the separate logger bot
  that already writes `<logDir>/<channel>/YYYY-MM-DD.md` picks it up the same
  as any other channel message.

**Prerequisite (`[Brandon/host]`, not done by this change):** the
Sexton/Bexton TS identities need an actual TeamSpeak server group carrying
the underlying kick/ban/move/edit permissions. The `allowGroups` config above
only gates who may *ask* the bot to moderate — the bot's own TS account still
needs the server-side permission to act, or every command above will fail at
the TeamSpeak server with a permission error (reported back as
`ModerationResult { ok: false, .. }`).

**Path B (deferred):** TS6 WebQuery on `:10080` would let the moderation
surface run over a real permission-scoped HTTP API instead of borrowing the
bot's own client connection, but `teamspeak6-server` currently refuses
connections on that port — WebQuery is not enabled on the server today. That
needs Brandon to enable it and mint a scoped API key; not attempted here.

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
| `web_search` | **done (#3788)** | see §6 below |
| `web_fetch` | **done (#3788)** | see §6 below |
| skills | **done (#3788)** | pruned from ~53 bundled to a curated per-persona list; see §6.3 |
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

#### Latency pass (Brandon 2026-09-25: "limit latency as much as possible")

Where a voice turn's time actually goes, from 12 live sexton turns on
2026-09-24 (whisper-local + MiniMax-M3 + MiniMax T2A, `thinkingDefault:
"medium"` still in effect on the box):

| stage | typical | notes |
| --- | --- | --- |
| hangover | 600 ms | `segmentation.hangoverMs`, spent *before* `closedAt`, so never in the log |
| queue wait | 0-3.4 s | invisible until now; a speaker chaining utterances waits for the previous turn's trailing chunk synthesis |
| `sttMs` | 1.4-2.0 s | whisper.cpp fixed 30 s mel window, box at load ~18/12 |
| `agentMs` | 2.4-3.8 s | full reply, no streaming; includes thinking at `medium` |
| `ttsMs` (first chunk) | 1.1-1.8 s | MiniMax T2A round trip, mostly fixed overhead |
| `firstAudioMs` | 5.1-8.8 s | sum of the above minus hangover |

What this issue ships against that:

| lever | status | effect |
| --- | --- | --- |
| `voice.thinking` → `"off"` | shipped (above) | removes the `medium` thinking spend from `agentMs`; measure after deploy |
| transcription off the serialized queue | shipped | STT starts at segment close instead of when the previous turn finishes synthesizing; the 2-3 s "unexplained" gap collapses to `max(0, prevTail - sttMs)` |
| TTS prefetch (chunk N+1 synthesizes while N plays) | shipped | shrinks inter-chunk gaps and shortens how long a turn holds the queue; first audio unchanged |
| `queueWaitMs=` in the per-turn log | shipped | the previously hidden stage is now a number |
| `hangoverMs` 600 → lower | **not changed** | it is a real 600 ms of first-audio, but it is the only thing keeping a mid-sentence breath from splitting one utterance into two turns; a config knob already, tune per room from the log rather than globally |
| `bootstrapContextMode: "lightweight"` | **cut** | it IS an ingress-exposed per-turn knob (`AgentCommandOpts`), but "lightweight" drops *every* bootstrap file (`bootstrap-files.ts` `applyContextModeFilter` returns `[]`), i.e. no SOUL/IDENTITY/AGENTS. That is "no persona", not "smaller persona". Not usable for a character bot. |
| stream the reply into TTS | **shipped (#3792, PR #31)** | `agent-turn.ts` now runs stt-tts voice turns through `runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher` instead of `runCommandFromIngress`: a finalized inbound context on the voice session key, `replyOptions.disableBlockStreaming: false` (forces block streaming on regardless of `agents.defaults.blockStreamingDefault`), `thinkingLevelOverride` for `voice.thinking`, and a dispatcher whose `deliver` hands every `block` payload to a new `SpeechPipeline` (`speech-pipeline.ts`) that splits, synthesizes with one-chunk prefetch, and enqueues on the room queue while the model is still generating. Nothing reaches the text channel: our `deliver` is the only delivery. Per-turn chunking rides on a copy of the config (`agents.defaults.blockStreamingChunk = {minChars 24, maxChars 400, sentence}`, coalesce `idleMs 0`), because the host default is 800-char paragraphs, which for a voice reply is the whole reply in one block. `voice.model` goes on that same copy (`getReplyFromConfig` has no one-shot model option; `/model` persists to the session). `final` payloads are dropped by the host when streaming succeeded and are spoken only if they carry text the blocks did not. Barge-in: the pipeline checks the turn generation before every enqueue. `voice.blockStreaming: false` restores the ingress path. The turn log gains `firstBlockMs=` (how far into `agentMs` the first block landed) and `replyPath=block-stream blocks=N`. Live measurement: pending the next voice turns on sexton after deploy; read `firstBlockMs` against `agentMs` on the `stt-tts turn` line. |

**Bottom line:** of the five asks, two were real, ingress-level, plugin-side
work and are done. The other three either don't exist as a per-call knob today
(`maxOutputTokens`, prompt/token/cost in the ingress result) or don't map to
the mechanism the issue assumed (prompt budget). Recommend a follow-up host
issue against `openclaw` core for `maxOutputTokens` override + usage-on-result
if the `requestedModel`/`requestedThinking` log line, once it has a few days
of live data, shows spend that's worth capping rather than just watching.

### 4.7 STT as a connector — **done (#3790)**
Full write-up: [STT-PROVIDERS.md](STT-PROVIDERS.md).

The premise turned out to be half wrong, which is the interesting part.
`sttProvider` was *not* already a switch — the name was validated in
`config.ts` against a hardcoded `LOCAL_TRANSCRIPTION_PROVIDERS` array and then
ignored by `stt-tts-lane.ts`, which built whisper as primary and MiniMax as
secondary no matter what config said. It was a label.

Shipped:

| Piece | Where |
| --- | --- |
| `transcribe(request) -> {text, provider, ms, confidence?, escalated?}` | `src/voice/stt-provider.ts` |
| Name → factory registry, aliases, `kind: local \| hosted` | `src/voice/stt-registry.ts` |
| `whisper-local` (whisper pool, #3598/3607), `minimax-asr` | their own modules, each with its own defaults and refusals |
| Both slots chosen by name from per-account config | `voice.streaming.transcription` / `.secondaryTranscription` |

Three notes worth keeping:

- **The privacy promise moved rather than left.** `LOCAL_TRANSCRIPTION_PROVIDERS`
  was the $0 / audio-stays-home rule as code; an open registry would have
  dropped it. Each factory now declares `kind`, and a hosted provider is refused
  in the *primary* slot unless the account sets `allowHosted: true`. Default
  behaviour is unchanged; the override is a named key, not a source edit.
- **`confidence` is real but off.** whisper only scores under `verbose_json`,
  measured at +1.8s per turn. `transcription.confidence: true` turns it on.
  The escalation router still does not read it, for exactly that reason.
- **`prompt` is wired and unset.** whisper takes an initial prompt; MiniMax has
  no such parameter and ignores it. Priming with the bot's own wake names is the
  obvious use (see the sexton/bexton cross-wake in #3605) but it changes what
  comes back, so it stays an operator decision rather than a default.

## 6. Web search + skills curation implementation (#3788)

Closes the "have-but-dead" gap from §4.5. Applied by hand on both live
gateway containers on PHATT-RAID (config is not reconstructed by
`deploy.sh` per #3601 — this needs redoing if either container is
rebuilt from scratch instead of restarted).

### 6.1 Provider: DuckDuckGo (key-free)

`tools.web.search.provider` is `duckduckgo`, not Brave/MiniMax/Gemini. It's
the only key-free provider OpenClaw ships (SearXNG needs a self-hosted
instance we don't have running); the task explicitly preferred a key-free
option unless clearly inadequate, and for "what's the weather" / general
lookup voice queries it's adequate. It is **not** auto-selected (OpenClaw
never auto-picks a key-free provider), and it is **not bundled** — it ships
as a separate plugin package that has to be installed per container:

```bash
docker exec <sexton|bexton> openclaw plugins install @openclaw/duckduckgo-plugin
# then in openclaw.json:
#   tools.web.search = { "enabled": true, "provider": "duckduckgo" }
#   tools.web.fetch  = { "enabled": true }
docker restart <sexton|bexton>   # plugin + tools changes both need a restart
```

Caveat from OpenClaw's own docs: DuckDuckGo here is an "experimental,
unofficial" HTML-scrape integration, not an API — expect occasional
breakage from bot-challenge pages. If that becomes a problem, Brave Search
(free tier, keyed) is the documented fallback; no key has been granted for
it, so it was not enabled per the "no paid service without explicit
approved spend" instruction.

### 6.2 `tools.allow` — actually wired as agent-level `alsoAllow`

Global `tools.allow` **replaces** the whole profile-derived tool set for
every agent on the gateway (Ledger, Mr. House, Jenkins, etc. all live on
the same `openclaw.json`) — setting it at the top level to
`["web_search","web_fetch"]` would have cut every other tool for every
other agent, a global-config trap in the same family as the
`enabled:false` channel-toggle trap. Instead:

```json5
// agents.entries.sexton.tools / agents.entries.bexton.tools
{
  "deny": ["process", "sessions_spawn"],      // unchanged
  "alsoAllow": ["web_search", "web_fetch"]    // added
}
```

`alsoAllow` is the additive form (merges on top of the existing profile +
deny) documented for exactly this per-agent case; `allow` at the agent
level has the same wholesale-replace semantics as the global key. Net
effect for both bots: same tool set as before, plus `web_search` and
`web_fetch`.

### 6.3 Curated skills per persona

OpenClaw ships 49 bundled skills under `/app/skills` plus 4 extension
skills (`browser-automation`, `canvas`, `obsidian-vault-maintainer`,
`wiki-maintainer`) — ~53 total, all loaded into prompt context by default
if no `agents.entries.<id>.skills` allowlist is set (it was unset for both
bots before this change). Curated via `skills: [...]` on each agent entry:

| Bot | Persona | Skills kept | Why |
| --- | --- | --- | --- |
| Sexton | general TS channel voice assistant + music | `weather`, `summarize`, `songsee`, `spotify-player`, `meme-maker`, `model-usage`, `healthcheck`, `control-ui` | small-talk/utility (`weather`), channel recap (`summarize`), music identification/lookup (`songsee`, `spotify-player`), voice-chat personality (`meme-maker`), self-ops (`model-usage`, `healthcheck`, `control-ui`) |
| Bexton | Velvet Vice Lounge Band leader, Suno song queue (#3554/#3636) | `weather`, `songsee`, `spotify-player`, `sonoscli`, `meme-maker`, `model-usage`, `healthcheck`, `control-ui` | same ops/personality set as Sexton, `sonoscli` in place of `summarize` since the band persona's job is playback/queue, not channel recap |

Everything else (github/gh-issues, 1password, apple-notes/reminders,
bear-notes, taskflow\*, things-mac, notion, obsidian, trello, coding-agent,
node-\*, python-debugpy, tmux, skill-creator, etc.) was cut — none of it is
used by a voice-chat/music persona, and per Brandon's ask this was a prompt-
budget trim, not a science project, so it stops at "what each persona
actually uses."

### 6.4 Live verification

Wanted: get Sexton to answer "Sexton, what's the weather in Dayton" over
TeamSpeak voice and confirm `web_search` actually fired.

What was tried and why the literal voice path doesn't have a scripted
test: `send-test` (`sexton/src/bin/send-test.rs`) only speaks TS **text**
chat (`say:<text>` steps) — text messages don't reach the STT/wake-gate
pipeline at all (confirmed live: a `say:` message produced no wake-gate log
line, while a real human talking in the same channel did produce
`wake gate declined` lines). `bridge-test` only emits sine tones for the
bot's own outbound-mixing test (#3174 acceptance test), not
speech-like input a real human speaker would produce, and there's no
documented bridge frame type for injecting a fake speaker's transcript.
Building a synthetic-speech-over-the-wire injector was out of scope for
this pass.

Verification actually used the exact same runtime path a voice turn does
(`runtime.agent.runCommandFromIngress`, i.e. the CLI's `openclaw agent`
command is not a separate mock — it drives the live gateway):

```bash
docker exec sexton openclaw agent --agent sexton \
  --message "Sexton, what's the weather in Dayton" --json --timeout 60
```

Result: `toolSummary: { "calls": 3, "tools": ["web_search","web_fetch"], "failures": 0 }`,
final reply `"Dayton, OH right now: sunny, 63°F (17°C), feels like ~61°F,
68% humidity, light wind out of the east at ~6mph..."` — a real, current,
specific answer, not a hallucinated one, so the tool actually executed
end-to-end (config → plugin → provider → result folded into the reply).

Same check against Bexton (`--agent bexton`) came back in-character
refusals ("I've got a band to run, not a barometer...") for both a direct
weather ask and a "search the web for..." rephrase — the persona declines
off-topic requests outright before reaching for a tool. Config-wise Bexton
is identical to Sexton (same `tools.web.search` block, same plugin
installed, same `alsoAllow`), so this reads as a persona/prompt behavior,
not a broken tool wire, but it means Bexton's `web_search` path is
**config-verified, not behavior-verified** — a genuine in-character prompt
that would make Bexton reach for search (e.g. "look up when the Velvet
Vice Lounge Band's next real-world namesake plays") is a follow-up if
that distinction matters.

### 6.5 Follow-ups

- Bexton's tool call has not been behavior-verified in-character (§6.4).
- No true TeamSpeak **voice** (audio-in) injection tool exists yet; §4.7's
  STT-as-a-connector work would be the natural place to add a "fake
  speaker" test harness (feed real PCM/TTS audio in as if a human spoke
  it) instead of relying on the text-only `send-test` or tone-only
  `bridge-test`.
- If DuckDuckGo's scrape-based provider proves flaky in practice, Brave
  Search is the documented next step, but needs an approved key/spend
  first — not enabled here.
- Lexton (#3819, added after this pass) has none of it: no
  `tools.web` block, no `alsoAllow`, no `skills` allowlist, so it still
  loads every bundled skill. Checked live 2026-10-01 (#3836); Sexton and
  Bexton still match §6.1-6.3 after their #3836 recreate (the
  DuckDuckGo plugin lives under `/config/openclaw/npm`, so it survives).

## 7. Things found on the way

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
