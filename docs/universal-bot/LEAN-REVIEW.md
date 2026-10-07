# Lean-code / dead-code review (#3807)

Brandon (#3783, 2026-09-26): "do a full dead code and lean code review."

This audit re-checked every candidate from the #3807 first pass against
the tree as it stands (origin/main, well past the da2e712 snapshot the pass
was written against — the repo has moved a lot in two weeks: `extensions/`
became `teamspeak-plugin/`, ts-bridge folded into `sexton/`, #3428
consolidated deploy into `image/`). Most candidates turned out to be false
positives once read against the comments already in the files — the codebase
narrates its own history unusually thoroughly, and several "why is this still
here" questions are answered inline within a few lines of the flagged code.
Method: `npx ts-prune`, `tsc --noEmit` (`npm run typecheck`), a manual read of
every flagged module, and `cargo clippy --all-targets -W dead_code -W unused`
built on PHATT-RAID in `rust:1-bookworm` (no host Rust toolchain here).

## Verdict summary

| # | Candidate | Verdict | Why |
| --- | --- | --- | --- |
| 1 | `sexton/` crate — "the original #3099 bot, duplicate of ts-bridge, two tsclientlib compiles" | **CLEARED — false premise** | #3342 already folded `ts-bridge` into this crate (`sexton::main` *is* the audio bridge; `Cargo.toml`'s own description says so). There is no second crate: workspace members are `sexton` + `bridge-proto`, and `bridge-proto` has no `tsclientlib` dependency (checked its `Cargo.toml` directly) — one crate compiles `tsclientlib`, not two. One CI workflow (`.github/workflows/sexton.yml`, extended by #3580) already covers `sexton/`, `teamspeak-plugin/`, and `image/` together — not a duplicate pipeline. `probe-channels`/`send-test`/`bridge-test` are the live-verify recipe binaries (`sexton/README.md`'s own binary table) and are `COPY`'d into the production image (`image/Dockerfile`). |
| 2 | `extensions/teamspeak/src/voice/realtime-speaker-session.ts` + realtime lane | **CLEARED** | Renamed to `teamspeak-plugin/` since the first pass. Not dead: it's a documented, supported alternate voice mode (`voice.mode: "agent-proxy"`) for third-party BYO-OpenClaw operators who want a hosted realtime provider instead of the $0 stt-tts lane — see `docs/universal-bot/BYO-OPENCLAW.md`'s config example, which explains the tradeoff and explicitly recommends `stt-tts` for our own bots while leaving the alternative wired up. Has its own test file (`realtime-speaker-session.test.ts`, 14 passing tests) and mirrors the Discord voice realtime pattern for maintainability. Sexton/Bexton not using it is a config choice, not a reachability bug. |
| 3 | `ts-bridge/tools/*.py` (ws-capture, ws-tone, analyze-duck, ws-oncassert) | **CLEARED, minor docs nit** | Path drifted to `sexton/tools/*.py`. These are the #3216/#3174 audio-quality acceptance scripts (584 lines total, stdlib-only Python, last touched at the #3342 fold). `sexton/README.md`'s binary table references them generically ("see `tools/*.py` for stdlib-Python equivalents") but doesn't name them individually. Not referenced by name from any doc, but each carries its own usage docstring and isn't imported/compiled/CI'd, so it costs nothing to keep. Recommendation: name them in the README table in a follow-up docs pass; not worth a code PR on its own. |
| 4 | `extensions/teamspeak/test/sdk-stubs/vendor/*` (audio-codec.ts, activation-name.ts) | **CLEARED — verified against the pin** | Diffed both files against a fresh checkout of `openclaw/openclaw` at the exact pinned commit (`fc1877d7f333a3546d8422956bbdb179f2cfc6cf`, the same commit already vendored under this project's `openclaw/` sparse checkout): byte-identical aside from the documented `expectDefined`/`levenshteinDistance` inlining. No drift. Neither is imported from `src/` (only from `test/sdk-stubs/realtime-voice.ts`), so there's no shadowing risk — `.dockerignore` also strips the whole `test/sdk-stubs` tree from the runtime image for the same reason. `ts-prune` flags a couple of their exports as "unused" but that's by design: these are deliberate full-surface mirrors of the real SDK module (see `realtime-voice.ts`'s own header comment on "faithful" vs "inert" exports) so that anything `src/` imports from the real SDK still resolves in the standalone stub, even names nothing currently calls. |
| 5 | `whisper/` dir vs the shared whisper container (#3598) | **CLEARED — this *is* the current path** | `whisper/` is the live #3598/#3607 shared pool (`deploy.sh`, `run-whisper-pool.sh`, `coalescing-proxy.mjs` + its own `node --test` suite, `verify.sh`). Only `whisper-compose.yml` inside it is old (the single-server sidecar), and the README already says so explicitly: "kept only as a record." Same pattern as candidate 6. |
| 6 | `sexton/deploy/*` vs `extensions/teamspeak/install/*` (now `teamspeak-plugin/install/*`) | **CLEARED — two different things, both used** | `teamspeak-plugin/install/*` builds/stages the plugin itself; `sexton/deploy/*` is the pre-#3428 bot deploy path. `sexton/README.md` already documents `sexton/deploy/*` as "superseded by `image/deploy.sh`... kept as the record of the settings proven here" — AND it's still load-bearing: `sexton/Dockerfile` (not `image/Dockerfile`) is published standalone as `ghcr.io/phattbeats/plnt-ts-bridge` for BYO-OpenClaw operators (#3798, landed days before this review), so the "old" deploy tree is the source for a currently-shipped image, not orphaned. |
| 7 | TS unused exports / dead config keys / unreachable tools (`tools/registry.ts`, `music.ts`) | **CLEARED — nothing genuinely dead** | `ts-prune -p tsconfig.json` over the whole plugin surfaces only "(used in module)" hits (exported for testability, a normal pattern here) or the intentional SDK-mirror exports from #4. Cross-checked every `*_TOOL` constant in `registry.ts` (37 of them) against its own file: none is defined without also being wired into `buildTeamSpeakTools`. `voice.realtime` config aliases are live per #2. Note: the persona-level `tools.json` allowlist the original issue assumed exists only on the still-blocked #3791 branch (`personas/<name>/tools.json`) — it isn't on `main` yet, so "tools unreachable from a persona allowlist" isn't yet a meaningful question against this branch. `npm run typecheck` and `vitest run` both green before and after this review (406 tests). |
| 8 | Rust `#[allow(dead_code)]` / commented-out blocks | **CLEARED — none exist** | No `#[allow(dead_code)]` or `#[allow(unused...)]` anywhere in `sexton/` or `bridge-proto/`. What a naive grep flags as "5+ line comment blocks" is this codebase's habit of long doc-comments, not commented-out code — read every one, none were. |
| 9 | Rust dead code via `cargo clippy -W dead_code` | **4 genuine, minimal findings — fixed in this PR** | See below. |

## What this PR actually removes

Found via `cargo clippy --release --all-targets -W dead_code -W unused`, built
on PHATT-RAID in `rust:1-bookworm` (this sandbox has no C toolchain, so it
cannot compile `tsclientlib` — the standing recipe for this crate).

| file | change | lines | why safe |
| --- | --- | --- | --- |
| `sexton/src/main.rs` | drop unused `tsclientlib::ClientDbId` import | -1 | grepped: zero uses in the crate |
| `sexton/src/protocol.rs` | drop dead `pub use bridge_proto::StateSnapshot;` re-export + rewrite the now-stale comment above it | -7/+4 | every real usage (`audio.rs`, `ws_server.rs`) imports `StateSnapshot` straight from `bridge_proto`, not through this re-export; nothing calls `protocol::StateSnapshot` |
| `sexton/src/protocol.rs` | drop `VoiceAudioHeader { count: usize }` struct | -4 | never constructed anywhere; the `TYPE_VOICE_AUDIO` dispatch arm in `ws_server.rs` reads `frame.payload` (raw PCM) directly and never deserializes a header for this message type — leftover from an earlier wire-format iteration |
| `sexton/src/ws_server.rs` | move `RosterEntry` import from the crate-level `use bridge_proto::events::{...}` into `#[cfg(test)] mod tests` | net 0 | clippy showed it unused in the non-test build only — it's real in the release binary (`#[cfg(test)]` compiles the only call sites out), still needed for the two `RosterEntry {...}` literals in `mod tests`, so scoped rather than deleted |

**Line-count**: `sexton/src/*.rs` went from 5,073 to 5,061 lines (-12 net,
including the rewritten comment). No behavior change; `cargo clippy
--all-targets -W dead_code -W unused` clean of all four findings afterward,
and `cargo test --release -p sexton -p bridge-proto` (13 + 36 tests) passes,
both verified on PHATT-RAID in `rust:1-bookworm`.

## Not fixed here (out of scope for a dead-code pass)

`cargo clippy`'s default lint groups (not `-W dead_code`) also flagged five
style nits — `chunks_exact` → `as_chunks`, `% 50 == 0` →
`.is_multiple_of(50)` (×2), `.split(...).last()` →
`.split(...).next_back()`, `.get(...).is_none()` →
`!...contains_key(...)` — in `audio.rs`, `protocol.rs`, `ws_server.rs`, and
`main.rs`. None is dead code; all are idiom suggestions with no behavior
change. Left for a separate, explicitly-scoped style pass rather than mixed
into a dead-code PR, per the "one PR per removal group, so a wrong cut can be
reverted alone" rule.

`sexton/tools/*.py` (candidate 3) would benefit from being named individually
in `sexton/README.md`'s binary table — a one-file docs diff, not bundled here
since it isn't a removal.
