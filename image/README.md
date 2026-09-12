# image/ — the Sexton as one container (PHA-3428)

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
| whisper.cpp + `ggml-base.en.bin` (PHA-3228) | `whisper` container, model on a host mount | `/opt/whisper`, weights **baked into the image** |
| ffmpeg, yt-dlp (PHA-3176) | nowhere — never installed | `/usr/local/bin`, on PATH for the plugin |
| bgutil POT provider | nowhere | `/opt/bgutil-pot`, served on `:4416` |
| OpenClaw gateway + `teamspeak` plugin | the main `OpenClaw` container | the base image, plus `/opt/openclaw-teamspeak-plugin` |
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
  `install/stage-teamspeak-link.sh` in the plugin repo still describes that
  install; it is now the *rollback* path, not the deploy path.

## A note on whisper, since PHA-3458

PHA-3458 makes MiniMax the primary STT provider with whisper.cpp as the
fallback. That does **not** take whisper or `ggml-base.en.bin` out of this
image: a fallback that has to be downloaded when the primary fails is not a
fallback. The weights stay baked in and `[program:whisper]` stays supervised.
