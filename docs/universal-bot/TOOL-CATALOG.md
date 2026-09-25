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

### 4.3 Moderation (PHA-3786 — gated: only on request from an allowed server group)

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
| stream the reply into TTS | **shipped (PHA-3792, PR #31)** | `agent-turn.ts` now runs stt-tts voice turns through `runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher` instead of `runCommandFromIngress`: a finalized inbound context on the voice session key, `replyOptions.disableBlockStreaming: false` (forces block streaming on regardless of `agents.defaults.blockStreamingDefault`), `thinkingLevelOverride` for `voice.thinking`, and a dispatcher whose `deliver` hands every `block` payload to a new `SpeechPipeline` (`speech-pipeline.ts`) that splits, synthesizes with one-chunk prefetch, and enqueues on the room queue while the model is still generating. Nothing reaches the text channel: our `deliver` is the only delivery. Per-turn chunking rides on a copy of the config (`agents.defaults.blockStreamingChunk = {minChars 24, maxChars 400, sentence}`, coalesce `idleMs 0`), because the host default is 800-char paragraphs, which for a voice reply is the whole reply in one block. `voice.model` goes on that same copy (`getReplyFromConfig` has no one-shot model option; `/model` persists to the session). `final` payloads are dropped by the host when streaming succeeded and are spoken only if they carry text the blocks did not. Barge-in: the pipeline checks the turn generation before every enqueue. `voice.blockStreaming: false` restores the ingress path. The turn log gains `firstBlockMs=` (how far into `agentMs` the first block landed) and `replyPath=block-stream blocks=N`. Live measurement: pending the next voice turns on sexton after deploy; read `firstBlockMs` against `agentMs` on the `stt-tts turn` line. |

**Bottom line:** of the five asks, two were real, ingress-level, plugin-side
work and are done. The other three either don't exist as a per-call knob today
(`maxOutputTokens`, prompt/token/cost in the ingress result) or don't map to
the mechanism the issue assumed (prompt budget). Recommend a follow-up host
issue against `openclaw` core for `maxOutputTokens` override + usage-on-result
if the `requestedModel`/`requestedThinking` log line, once it has a few days
of live data, shows spend that's worth capping rather than just watching.

### 4.7 STT as a connector — **done (PHA-3790)**
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
| `whisper-local` (whisper pool, PHA-3598/3607), `minimax-asr` | their own modules, each with its own defaults and refusals |
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
  obvious use (see the sexton/bexton cross-wake in PHA-3605) but it changes what
  comes back, so it stays an operator decision rather than a default.

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
