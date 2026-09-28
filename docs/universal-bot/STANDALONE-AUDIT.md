# Standalone plugin audit (PHA-3806)

Brandon (PHA-3783, 2026-09-26): "now that we are making an openclaw plugin, i also
want to make sure this is fully standalone as well."

Audited `origin/main` at `da2e712` (PHA-3790 merged). Scope: `teamspeak-plugin/`
(the repo moved `extensions/teamspeak/` here before this pass — see README's
history note), `sexton/` (the `plnt-ts-bridge` image), `openclaw.plugin.json` +
`package.json`, and the moderation/music/TTS defaults PHA-3798 said would fail
closed for a foreign server.

Method: `grep -rniE` across `teamspeak-plugin/src`, `sexton/`, and the manifests
for `whisper`, `10.0.0.100`, `teamspeak6-server`, `phatt.vip`, `/root/.openclaw`,
`sexton`/`bexton`, MiniMax model ids, `phattvip`, plus a manual read of
`src/config.ts` (every `DEFAULT_*` constant), `openclaw.plugin.json`,
`package.json`, `sexton/Dockerfile`, and the existing `docs/universal-bot/
BYO-OPENCLAW.md` (PHA-3798 already wrote most of the security-defaults story;
this pass verifies it in code, not just docs, per the issue's own instruction).

## 1. `teamspeak-plugin/` hardcoded-assumption grep

| Term | Where it shows up | Verdict |
| --- | --- | --- |
| `whisper` | `DEFAULT_WHISPER_URL = "http://whisper:8080/inference"` (`src/config.ts`) | **Fine as shipped.** Overridable via `channels.teamspeak.voice.streaming.transcription.url` or `TEAMSPEAK_WHISPER_URL`; the container-name default only resolves inside our own compose network, and `BYO-OPENCLAW.md` §3 already tells a stranger they need *some* whisper.cpp endpoint and to point this at it. No plugin code assumes anything beyond "an HTTP URL exists." |
| `10.0.0.100`, `teamspeak6-server`, `phatt.vip`, `phattvip` | Not present in `teamspeak-plugin/src` or `sexton/` at all | Clean. These only appear in `image/` (our all-in-one deploy, explicitly out of scope per the issue) and `sexton/deploy/`, `sexton/README.md`'s live-verify recipe. |
| `/root/.openclaw` | Not present in `teamspeak-plugin/src` or `sexton/` | Clean. |
| `sexton` / `bexton` | Comments and log-line prefixes (`!sexton status`, fuzzy-wake examples, `HUMAN.md` references), one hardcoded fallback wake name (`names.length > 0 ? names : ["sexton"]`, `voice-runtime.ts`) | The fallback wake name only fires when `wakeNames` is completely unset — a config gap, not a functional lock-in — and every other reference is a doc-comment example, not code that runs unconditionally. Not blocking; noted for whoever picks up wake-name UX polish. |
| MiniMax model ids (`speech-2.8-hd`, `music-3.0`, `asr-1.0`) | `DEFAULT_SPEECH_MODEL`, `DEFAULT_MINIMAX_MUSIC_MODEL`, `DEFAULT_MINIMAX_ASR_MODEL` | These are *provider defaults for a provider a BYO operator opts into*, not deployment assumptions — same category as any other extension's default model id. Not a standalone violation by itself; see finding 5 for the bigger question (is MiniMax-as-TTS-default itself the right call for a stranger). |
| **`DEFAULT_SEXTON_LOG_DIR = "/mnt/user/appdata/sexton"`** (`src/config.ts`) | Fallback for `what_did_i_miss`'s markdown log root when neither `tools.logDir` nor `TEAMSPEAK_SEXTON_LOG_DIR` is set | **Filed, not fixed this pass — see "Open: needs live verification" below.** This is our Unraid host path baked in as the plugin's own default, and unlike `music.enabled` there is no evidence our own deploy (`image/gateway/openclaw.seed.json`, `image/run-gateway.sh`, `image/unraid-sexton.xml`) ever sets `TEAMSPEAK_SEXTON_LOG_DIR` explicitly — Sexton/Bexton's live catch-up logging may be relying on this exact default today. Changing it blind risks silently moving (or breaking) their live chat-memory storage, which needs a live-container check first, not a grep-driven guess. |

## 2. `sexton/` (the `plnt-ts-bridge` image)

`sexton/Dockerfile` — confirmed generic: `ENV RUST_LOG=info` is the only baked
env var, no identity/avatar/channel/persona files copied in beyond
`sexton/avatar/brandon.png` (used only as a fallback default, per
`docker-entrypoint.sh` / `BYO-OPENCLAW.md`'s env table — a stranger overrides
it same as everything else). `TS_BRIDGE_*` env vars (address, port, channel,
nickname, identity file) are exactly what `BYO-OPENCLAW.md` §1 documents.
**No code change needed — already satisfies item 2.**

## 3. Install path (`openclaw.plugin.json` + `package.json`)

- `activation.onStartup: false`, `channelConfigs.teamspeak.schema` — clean, no
  RAID-specific defaults baked into the manifest.
- `package.json`'s `openclaw.extensions: ["./index.ts"]` pointing at a `.ts`
  source file, not `dist/index.js`, looked like a bug at first read (this is
  exactly the "missing dist/ wall" PHA-3798 said it fixed). It is not: per
  `scripts/build.mjs`'s own header comment, OpenClaw's installer infers the
  compiled counterpart next to the declared `.ts` entry automatically for
  every non-`--link` install kind (`package-entry-resolution.ts` /
  `plugin-peer-link.ts` upstream in `openclaw/openclaw`) — confirmed by
  reading that upstream module, not just trusting the comment. `dist/` only
  needs to exist and stay in sync; it does not need to be the declared entry.
- **Found and fixed: `dist/` was stale.** A fresh `npm run build` against
  `origin/main` (da2e712, before this pass's other edits) produced a diff
  against six *already-tracked* files (`config.js`, `minimax-asr.js`,
  `stt-routing.js`, `stt-tts-lane.js`, `stt-tts-speaker-session.js`,
  `whisper-local.js`) and two entirely **missing** files
  (`stt-provider.js`, `stt-registry.js` — PHA-3790's provider-registry
  refactor never got rebuilt into `dist/`). That means every `npm:`/
  `npm-pack:`/`git:` install today would ship pre-PHA-3790 STT behavior
  silently, contradicting the "CI-checked not to drift" claim in
  `BYO-OPENCLAW.md`. Root cause: the CI step meant to catch this
  (`.github/workflows/sexton.yml`, "Build and check dist/ is committed") ran
  `git diff --exit-code -- dist`, which never reports *untracked* files — a
  new `src/*.ts` file whose `dist/*.js` counterpart was never `git add`ed
  passes silently. Fixed both halves this pass:
  - Rebuilt and committed `dist/` against current `src/` (this PR).
  - Changed the CI check to `git add -A -- dist` before diffing, so a missing
    new file fails the build instead of passing.
- **Still open: the actual "install into a stock gateway" DoD run.**
  `BYO-OPENCLAW.md` already says, in its own words, "Not yet run end to end
  by anyone outside this repo." That's still true after this pass — filed as
  a follow-up (see "Follow-ups" below) rather than attempted here: it needs a
  throwaway `ghcr.io/openclaw/openclaw` container plus the published
  `plnt-ts-bridge` image on a scratch box, joined to a real TS6 server, which
  is a distinct infra task from a source-level audit.

## 4. Moderation/music/text-command defaults

The issue asked this to be verified in code, not docs — `BYO-OPENCLAW.md`
already *documented* all three; here's what the code actually does as of this
pass:

- **Moderation: already fails closed.** `isTeamSpeakMusicEnabled`'s sibling
  gate, `TeamSpeakModerationConfig.allowGroups`, disables every kick/ban/edit
  tool when absent or empty (`src/tools/registry.ts`, doc comment on
  `TeamSpeakModerationConfig`). No code change needed.
- **Music: was NOT failing closed — fixed this pass.**
  `isTeamSpeakMusicEnabled` returned `true` unless `tools.music.enabled` was
  explicitly `false` — i.e. unset defaulted to *on*, the opposite of what
  PHA-3798's own DoD and `BYO-OPENCLAW.md`'s "Security defaults" section say
  should happen. Changed the check to require `tools.music.enabled === true`.
  Verified safe for our own deployment: `image/gateway/openclaw.seed.json`
  sets `tools.music.enabled: true` explicitly, so Sexton/Bexton are
  unaffected. Updated the doc comment on `TeamSpeakMusicConfig.enabled` and
  `BYO-OPENCLAW.md`'s "Security defaults" section to match. Two
  `voice-runtime.test.ts` fixtures that exercised the band feature were
  relying on the old implicit default and needed an explicit
  `music: { enabled: true }` added — fixed alongside (band already required
  music per `isTeamSpeakBandEnabled`'s existing `&&`, so this is not a new
  requirement, just no longer a free ride from the default).
- **Text commands (`commandAllowFrom`): still open, not code-fixed.**
  Unset genuinely means "anyone in the channel" (`src/voice/commands.ts`,
  confirmed in code, not just the doc comment). Unlike music, this default is
  *not* free to flip: nothing in our own deploy config sets
  `commandAllowFrom` either, so Sexton/Bexton's own live `!sexton`/`!vc`
  commands rely on the current "anyone" default for their own
  semi-trusted channel on purpose (per `BYO-OPENCLAW.md`'s existing framing).
  Making a foreign-server default safe without breaking that would need a
  new config concept (e.g. an explicit "trusted channel" opt-in so unset can
  mean deny) — a config-schema addition, which per repo policy needs
  discussion/approval before implementation, not a unilateral flip in an
  audit pass. Left as a documented, deliberate risk (already covered in
  `BYO-OPENCLAW.md`'s "Security defaults" section: set `commandAllowFrom: []`
  explicitly). Filed as a decision item, see "Open decisions" below.

## 5. TTS hardwired to MiniMax (cross-ref PHA-3790)

`DEFAULT_SPEECH_PROVIDER = "minimax"` (`src/config.ts`). The synthesis call
itself already fails loudly per-turn when unconfigured — `speech.ts`'s
`RuntimeSpeechSynthesizer` sets `disableFallback: true` deliberately ("Fail
loudly instead" is in the existing code comment) and returns
`{status:"failed", error}` rather than silently no-op'ing. **Resolved (Brandon, 2026-09-27: "startup check").** `createSttTtsLane` now asks
the host's own `isTtsProviderConfigured` (`openclaw/plugin-sdk/tts-runtime`,
same key resolution synthesis uses: config key, env key, or auth profile)
once at startup. If the speech provider isn't configured the lane is refused
with one warning naming the provider and where to configure it, exactly like
an unknown STT provider or a missing `bridgeUrl` — no per-turn failures.
MiniMax stays the default *provider name*; it just no longer starts unless
the gateway can actually use it. Regression test in
`test/stt-tts-lane.test.ts`.

## Fixes shipped in this PR

1. `teamspeak-plugin/src/config.ts` — `tools.music.enabled` now defaults to
   `false` (fails closed), doc comment updated.
2. `teamspeak-plugin/test/voice-runtime.test.ts` — two band-feature fixtures
   now set `music: { enabled: true }` explicitly.
3. `teamspeak-plugin/dist/**` — rebuilt against current `src/` (was stale
   since before PHA-3790; two files were missing entirely).
4. `.github/workflows/sexton.yml` — the "Build and check dist/ is committed"
   step now stages before diffing (`git add -A -- dist`), so a PR that adds a
   new `src/*.ts` file without its `dist/*.js` counterpart fails CI instead of
   merging silently.
5. `docs/universal-bot/BYO-OPENCLAW.md` — updated the music-default section to
   match the new code default.
6. `teamspeak-plugin/src/voice/stt-tts-lane.ts` + `speech.ts` — startup TTS
   configured-check (finding 5), with an SDK stub for the standalone harness.

## Decisions (answered 2026-09-27)

- **TTS standalone default** (finding 5): startup check, refuse voice until
  configured — implemented, see finding 5.
- **`commandAllowFrom` foreign-server default** (finding 4): documented risk
  is the accepted answer; no code change. BYO operators set
  `commandAllowFrom: []` themselves (`BYO-OPENCLAW.md`, "Security defaults").

## Follow-ups filed

- **Live install verification** (finding 3's remaining DoD item): pull a
  stock `ghcr.io/openclaw/openclaw` image and the published
  `ghcr.io/phattbeats/plnt-ts-bridge` image onto a throwaway box (not
  Sexton/Bexton's live containers), install `@openclaw/teamspeak` via
  `npm-pack:`, and join a real TS6 server end to end. This is the "one green
  install from a clean gateway" half of the DoD and is a distinct infra task
  from this audit — tracked separately so PHA-3806 isn't blocked on infra
  turnaround.
- **`DEFAULT_SEXTON_LOG_DIR`** (finding 1): needs someone to check what path
  is actually mounted/writable inside the live Sexton/Bexton container before
  either (a) pinning `TEAMSPEAK_SEXTON_LOG_DIR` explicitly in our own deploy
  config so the plugin's own default can safely change, or (b) confirming the
  current default is intentionally relied upon and just needs a comment
  explaining why it's safe to leave as-is for now. Not done in this pass
  because guessing wrong risks Sexton/Bexton's live chat-memory storage, a
  live production concern this audit should not touch without verification.

## Coordination note (PHA-3791)

PHA-3791 (universal persona-pack consolidation) is **blocked**, not
in-progress, as of this pass — its own issue says it's waiting on the
tool-group work landing first. No overlapping file changes were made here
beyond `src/config.ts`, its own test, `dist/`, one CI workflow step, and two
docs files, so there's nothing to reconcile with PHA-3791 when it resumes.
PHA-3807 (dead-code review) is in progress concurrently against the same
repo; this pass did not touch any of the files PHA-3807's description lists
as deletion candidates (`sexton/` crate internals beyond the Dockerfile ENV
lines already read-only here, `realtime-speaker-session.ts`,
`ts-bridge/tools/*.py`, vendor stubs).
