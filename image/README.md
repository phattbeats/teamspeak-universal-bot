# image/ — every TeamSpeak bot as one container (PHA-3791)

Brandon, 2026-10-02/03: "since openclaw can handle multiple agents, cant they
all be under one, expanding container?" ... "combine everything into one".

```
image/Dockerfile               the image: phattbeats/teamspeak-universal-bot
image/build.sh                 build + verify it (on PHATT-RAID)
image/deploy.sh                (re)create the teamspeak-universal-bot container
image/universal/stack.mjs      bots.json + persona packs -> supervisor programs, summoner config, gateway accounts
image/universal/migrate.mjs    one-time move from the old per-bot containers
image/universal/supervisord.conf  PID 1 (the bots' programs are generated into /run/universal/bots.conf)
image/run-*.sh, universal/run-*.sh  env -> argv wrappers for each program
image/gateway/                 the gateway's seed config and core patches
```

## What runs in it

| program | what | was |
| --- | --- | --- |
| `core-<id>` | one Rust core per bot: its TeamSpeak identity, nick, avatar, bridge socket on `127.0.0.1:91xx` | the `sexton`/`bexton`/`lexton`/`guest` containers |
| `gateway` | ONE OpenClaw gateway: agent + `channels.teamspeak.accounts.<id>` + binding per bot | one gateway per container |
| `whisper` | 2 whisper.cpp workers + the coalescing proxy on :8082 (PHA-3921) | the `whisper` container |
| `pot` | bgutil POT provider for yt-dlp | per container |
| `suno-api` | gcui-art/suno-api + `suno-api/phattbeats.patch`, chromium, on :3000 | the `suno-api` container |
| `summoner` | ts-summoner: shifts, summons, scenes, guests; starts/stops `core-<id>` | the `ts-summoner` container |
| `menace-<id>` | Lexton's menacing DMs, for a bot with `menace: true` | a program in `lexton` |

## Volumes (`/mnt/user/appdata/teamspeak-universal-bot`)

| path | holds |
| --- | --- |
| `config/bots.json` | which bots run; bridge ports (assigned once, never move); `identity` sharing (the guests share one); `menace`, `noCatchup`, `noWelcome`, `autostart`, `nick`, `env` |
| `config/bots/<id>/` | `sexton-id.txt` (the TeamSpeak identity), `.announce`, `.off-duty`, band songs, villain state |
| `config/openclaw/` | the gateway's `openclaw.json`, agents (transcripts), workspaces |
| `config/summoner/` | `config.json` (shifts etc., editable), `live/`, `state/`, `query-pass.txt` |
| `config/suno-api.env` | Suno cookie, 2Captcha key, proxy (0600) |
| `config/personas/<id>/` | optional: a pack added or overridden without a rebuild |
| `logs/<id>/` | each core's room log |

## Adding a bot

Drop a pack in `personas/<id>/` (rebuild) or `config/personas/<id>/` (no
rebuild) with at least a `voice.json`, then restart the container. stack.mjs
adds it to `bots.json` with the next free port and seeds its workspace,
agent, account and binding. The summoner keeps a bot it has no shifts for on
duty around the clock; give it shifts in `config/summoner/config.json`. A new
identity joins as an unprivileged client: add it to the Sexton server group
(PHA-3793) if it needs moderation.

What is seeded once (then the operator's): the workspace, the agent entry,
the account's voice/tool tuning. What follows `bots.json` every boot: the
bridge URL, announce/villain/log paths, the summoner URL and self id, the
whisper/POT/suno URLs.

## Tradeoffs (accepted 2026-10-03)

One gateway restart takes every bot offline at once, any gateway config
change that needs a restart bounces all of them, and the per-container CPU
limits are gone. In exchange: one deploy, one config, one set of credentials,
and a guest visit no longer restarts anything.

---

# History: the Sexton as one container (PHA-3428)


Brandon's decision, 2026-09-12: the Sexton stack deploys as **one Docker
container** on PHATT-RAID. One image, one container, one Unraid template entry.

```
image/Dockerfile          the image
image/build.sh            build it (run on PHATT-RAID — the sandbox has no C toolchain)
image/deploy.sh           docker run form; also removes the sidecars it supersedes
image/unraid-sexton.xml   the Unraid template
image/supervisord.conf    PID 1
image/run-*.sh            env -> argv wrappers for each supervised program
image/healthcheck.sh      one healthcheck for a container that runs several things
image/gateway/            the in-container OpenClaw gateway's seed config + notes
```

## What is in the container

| piece | was | is now |
| --- | --- | --- |
| Sexton bot | `sexton` container | the `sexton` binary |
| audio bridge (PHA-3174) | `ts-bridge` container | same binary — folded in by PHA-3342 |
| whisper.cpp + `ggml-base.en.bin` (PHA-3228) | `whisper` container, model on a host mount | `/opt/whisper`, weights **baked into the image** — and since PHA-3598 run as the shared `whisper` pool container again (same image, `whisper/deploy.sh`), with the in-container copy left down (`WHISPER_ENABLED=0`) |
| ffmpeg, yt-dlp (PHA-3176) | nowhere — never installed | `/usr/local/bin`, on PATH for the plugin |
| bgutil POT provider | nowhere | `/opt/bgutil-pot`, served on `:4416` |
| OpenClaw gateway + `teamspeak` plugin | the main `OpenClaw` container, plugin source in its own repo | the base image, plugin baked in from [`teamspeak-plugin/`](../teamspeak-plugin/) (PHA-3580) at `/opt/openclaw-teamspeak-plugin` |
| supervisor | n/a (one process per container) | `supervisord` as PID 1 |

Three containers become one, and the channel comes with it.
`image/deploy.sh` removes `ts-bridge` and `whisper` as part of deploying,
because leaving `whisper` up would mean two transcribers and a real chance
something is still pointed at the stale one — and it disables the `teamspeak`
channel on the main gateway for the same class of reason: two gateways on one
bridge socket is two answers to every message.

### Why the weights are baked in and not mounted

`whisper/deploy.sh` fetched `ggml-base.en.bin` (~148 MB) once into
`/mnt/user/appdata/whisper/models` and mounted it read-only. That was right for
a sidecar and wrong for a single image: it makes the container's most important
non-code asset a thing that lives outside the image, is not versioned with it,
and that a fresh deploy on a fresh box silently does without. It is now a build
stage with its own layer, so a rebuild that changes only Rust code does not
re-download it.

### Why a supervisor, specifically

The isolation we gave up by folding whisper in is the real cost of this issue.
A 4-thread `base.en` inference on a box that is also running Plex, the *arrs,
and a Blender render is a genuine OOM candidate, and as separate containers its
death could not touch the bot. `supervisord` with `autorestart=true` buys that
back inside one container — and `image/healthcheck.sh` deliberately does **not**
treat whisper being down as unhealthy, because a Docker-level restart would take
the bot out of the channel and undo exactly the thing the supervisor is there to
preserve.

## Bexton and the house band (PHA-3554)

Bexton leads The Velvet Vice Lounge Band. He is **the same image as a second
container**: same binary, same bridge, same in-container gateway, and three
things different, all env:

| knob | Sexton | Bexton |
| --- | --- | --- |
| `SEXTON_AGENT_ID` | (empty: the imported `sexton` agent) | `bexton` — `run-gateway.sh` seeds `/opt/sexton-persona/bexton/` (`personas/bexton/`) into the gateway workspace on first boot, adds the agent entry with the Sexton's model block, and binds the channel to it |
| `SEXTON_WAKE_NAMES` | seed default (`Sexton`, `Henchman`) | `Bexton,band leader,maestro` |
| `SEXTON_WAKE_ALIASES` | `section,sections,sex and,sexin,saxton,sex ton,sex done` (exact whisper hearings, PHA-3605) | (empty) |
| `SEXTON_EXCLUDE_WAKE_NAMES` | `Bexton,band leader,maestro` (never answer the other bot's name) | `Sexton,Henchman` |
| `SEXTON_BAND_ENABLED` | `0` | `1` — writes `tools.band` into the channel block, reusing the TTS block's MiniMax key |
| `SEXTON_WHISPER_URL` | `http://whisper:8082/inference` | `http://whisper:8082/inference` — both bots share the pool's coalescing proxy (PHA-3607), which fans one decode out to both when they segment the same utterance and otherwise round-robins across the two workers; first-boot only, the mounted `openclaw.json` wins afterwards |
| `WHISPER_ENABLED` | `0` | `0` — the in-container whisper-server stays down while the pool is the transcriber |

### The shared whisper pool (PHA-3598)

Two bots in one channel each ran their own `whisper-server` and each decoded
every speaker, including the other bot, so a busy room cost 2-3 cores per bot
and bexton's 2-thread decoder fell minutes behind. `whisper/deploy.sh` now runs
the same image as a third container named `whisper` with N `whisper-server`
processes on consecutive ports (whisper.cpp's server has **no** request-level
parallelism flag; it serialises behind one mutex, so "parallel" means one
process per bot) and silero VAD in front of the decoder, which turns a
silence/noise segment into a ~200 ms empty answer instead of a 4-12 s decode.
Each bot was pointed at its own port. Health: the pool container runs with
`--no-healthcheck` because the image's healthcheck is the bot's, not whisper's.

**PHA-3607** found the next layer of the same waste: even with each bot on
its own worker, the two bots still decoded the *same* speech separately —
one worker each, but the same audio twice. `whisper/coalescing-proxy.mjs`
sits in front of the pool (`:8082` by default) and both bots now point at it
instead of at a worker directly; see `whisper/README.md` for how the
coalescing key works and `whisper/coalescing-proxy.test.mjs` for its tests.

Cutover on a live bot, in this order, or the edit is lost: `supervisorctl stop
gateway`, edit the URL in the mounted `openclaw.json` (`docker exec -i` if you
pipe a script in — without `-i` python gets an empty stdin and writes nothing),
`supervisorctl stop whisper`, `supervisorctl start gateway`, then confirm the URL
in the file after boot and `fetch failed` stays at zero.

`image/deploy-bexton.sh` sets those and calls `image/deploy.sh` with its own
`NAME`/`APPDATA` (`/mnt/user/appdata/bexton`), `IMPORT_FROM=sexton` (the
credentials come from the config known to work on this lane, not the main
gateway's), and `DISABLE_MAIN_TEAMSPEAK=0` (the Sexton's deploy already did
that). `image/unraid-bexton.xml` is the same thing as a template. Both need
Bexton's **own** TeamSpeak identity at `$APPDATA/config/sexton-id.txt` — never
the Sexton's, two bots on one UID and the server drops one — and the first boot
generates and prints one; give it the Sexton's server group afterwards.

How a song happens is in the plugin README (`compose_song`): the agent writes
title and lyrics, the tool returns at once, and when the generator delivers, the
band leader announces over the voice lane and starts the track on the music
lane, so `stop_music` stops the band too. Files land in
`$APPDATA/config/band-songs/`, newest 20 kept.

### The generator is the open question

Probed 2026-09-17 with the granted MiniMax key: `POST /v1/music_generation`
returns **status 2153, "This Music API is no longer available to new users.
Existing paying customers can continue"** on `music-2.5`, `music-2.0`,
`music-1.5` and `music-01` alike. So the provider the issue was written against
only works if the MiniMax account behind the TTS key already paid for music.
The plugin therefore ships three generators behind one interface and Bexton's
deploy picks one with `BAND_PROVIDER`:

- `minimax` — the default; works only for an existing music customer.
- `suno-api` — a self-hosted [gcui-art/suno-api](https://github.com/gcui-art/suno-api)
  container on `phattvip`, driven by a Suno web-account cookie (Suno has no
  official API). `BAND_SUNO_API_URL=http://suno-api:3000`. Free beyond the Suno
  plan, but it is a browser-cookie automation and breaks when Suno changes.
- `command` — any executable at `/config/band/generate` (spec as JSON on
  stdin, `{audioPath}` on stdout). The seam for a self-hosted open model
  ([MiniMax-Music3](https://huggingface.co/MiniMaxAI/MiniMax-Music3), ACE-Step)
  — which on this box means CPU inference, minutes per song, or a GPU it does
  not have.

None of these is switched on by this repo; the band lane refuses to start and
logs why until one is configured, and the rest of Bexton (voice, chat,
`play_music`) comes up regardless.

## Where the OpenClaw plugin runs

The issue asked for a decision between:

- **(a)** this container runs its own OpenClaw gateway with the `teamspeak`
  plugin installed, or
- **(b)** the plugin stays in the main OpenClaw gateway and this container
  exposes the bridge socket to it,

with a preference for (a) "unless it doubles the gateway's config burden".

**It is (a).** An earlier revision of this file took the escape hatch and
argued for (b); Brandon overruled that on 2026-09-12:

> **option (a)** — this container runs its own OpenClaw gateway instance with
> the teamspeak plugin installed via the PHA-3326 managed install. Do not wire
> the bridge socket out to the main gateway.

So the gateway is in here, started by `supervisord` as `[program:gateway]`, and
the plugin is `--link`-installed into it on every boot by
`image/run-gateway.sh`. See `image/gateway/README.md` for the config side.

### What (a) buys

1. **The internal ports stop being a network surface.** Under (b) the bridge,
   whisper and the POT provider had to be reachable from another container on
   `phattvip`. Under (a) the only process that dials them is in this container,
   over loopback. For a lane whose entire premise is that the channel's audio
   does not leave the box, that is the right shape.
2. **ffmpeg and yt-dlp land where they are actually spawned.** They are spawned
   **by the plugin** — see `src/tools/music.ts` and `src/voice/speech.ts` in
   `openclaw-teamspeak-plugin` — and the stock gateway image has neither
   installed (checked: `which ffmpeg yt-dlp` in the running `OpenClaw`
   container returns nothing), which is why the music lane and the TTS decode
   path never actually worked there. Under (a) the plugin and the binaries are
   the same container. The `/opt/sexton-tools` export that (b) needed is gone.
3. **The last manual step in this issue is gone with it.** (b) required a human
   to add two read-only path mappings to the `OpenClaw` container in the Unraid
   GUI. (a) requires none.

### What (a) costs — the escape hatch was not wrong, just overruled

The (b) argument was that a second gateway needs its own config file, state
dir, agent identity and model credentials, and that PHA-3326's finding — a core
version bump does not update a managed channel plugin — means every OpenClaw
upgrade now has to be performed and verified in two places. **All of that is
still true.** What changed is who decides whether it is worth paying.

The image pays down the parts it can:

- `run-gateway.sh` re-runs the `--link` install on every boot, so *this*
  gateway self-heals after an image bump. The main gateway still needs its own
  `openclaw channels status` check after an upgrade.
- `image/deploy.sh` imports the `models`/`auth`/`agents`/`tts` blocks out of
  the main gateway's config once, so nobody retypes an API key into a second
  file. It deliberately does **not** import `channels` — that would start
  Discord, Signal and WhatsApp in here too.
- `image/gateway/openclaw.seed.json` ships the whole teamspeak channel block
  pre-wired to loopback, so first boot is configured, not blank.

What is left is genuinely irreducible: two gateways to keep on one version.
`OPENCLAW_VERSION` in `build.sh` is pinned to the main gateway's version for
exactly that reason — check `docker exec OpenClaw openclaw --version` before
bumping it.

### The cutover has a sharp edge

Until the main gateway's `teamspeak` channel is **disabled**, both gateways are
connected to the same bridge socket and the room hears every answer twice, from
two different agents. `image/deploy.sh` does this automatically
(`DISABLE_MAIN_TEAMSPEAK=1`, the default). If you deploy by hand:

…and there is **no CLI for it**. `openclaw channels disable` does not exist,
and `openclaw channels remove --channel` takes a fixed enum of built-in channel
names that a *plugin* channel like `teamspeak` is not in.

**Delete the block. Do not set `enabled: false` on it.** The plugin declares
its channel schema with `additionalProperties: false`, so an `enabled` key
makes the whole config invalid — `must not have additional properties:
"enabled"` — and that gateway then refuses to start *at all*, taking Discord,
Signal and WhatsApp with it. That is a worse outage than the double-answer this
step exists to prevent, and it is what happened on the first attempt.

```bash
docker exec OpenClaw node -e '
  const fs = require("fs"), p = "/root/.openclaw/openclaw.json";
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  fs.writeFileSync("/root/.openclaw/openclaw.json.teamspeak-block.bak",
                   JSON.stringify(c.channels.teamspeak, null, 2) + "\n");
  delete c.channels.teamspeak;
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
'
docker restart OpenClaw
```

`image/deploy.sh` does exactly this, and only after confirming the
in-container gateway has the channel connected. The saved block is what makes
the (b) rollback a copy-back rather than a retype.

`config.ts`'s comment that the POT provider is "an image concern, not a plugin
concern" was written when PHA-3306's custom-gateway-image plan was still alive.
That plan is dead; this is its replacement, and under (a) the provider and the
plugin are finally in the same container.

## Ports

`9099` bridge WebSocket · `8080` whisper · `4416` POT provider ·
`18789` the in-container gateway.

**None of them is published to the host.** The local STT lane exists so the
channel's audio does not leave the box, and a published port is the easiest way
to lose that by accident. Under (a) the first three are reached over loopback by
a process in this same container and have no remaining reason to be reachable
from anywhere else. `18789` is this gateway's own control port — publish it only
if you actually want a second Control UI, and put auth on it if you do.

## Superseded

- `sexton/Dockerfile` — kept for the CI compile check only; the deployed image
  is built from `image/Dockerfile`.
- `sexton/deploy/deploy.sh`, `sexton/deploy/sexton-compose.yml` — replaced by
  `image/deploy.sh` / `image/unraid-sexton.xml`.
- `whisper/deploy.sh`, `whisper/whisper-compose.yml` — the sidecar is gone.
  `whisper/verify.sh` still works if you point it at the `sexton` container.
- The multi-container deploy steps in PHA-3220 and PHA-3306.
- The `teamspeak` channel on the main `OpenClaw` gateway, and the
  `/opt/sexton-tools` + `/etc/yt-dlp/plugins` path mappings it needed there.
  [`teamspeak-plugin/install/stage-teamspeak-link.sh`](../teamspeak-plugin/install/stage-teamspeak-link.sh)
  (PHA-3580: moved here with the rest of the plugin, still named for its own
  now-private repo in its comments) still describes that install; it is now
  the *rollback* path, not the deploy path.

## A note on whisper, since PHA-3458

PHA-3458 makes MiniMax the primary STT provider with whisper.cpp as the
fallback. That does **not** take whisper or `ggml-base.en.bin` out of this
image: a fallback that has to be downloaded when the primary fails is not a
fallback. The weights stay baked in and `[program:whisper]` stays supervised.
