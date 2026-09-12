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
```

## What is in the container

| piece | was | is now |
| --- | --- | --- |
| Sexton bot | `sexton` container | the `sexton` binary |
| audio bridge (PHA-3174) | `ts-bridge` container | same binary — folded in by PHA-3342 |
| whisper.cpp + `ggml-base.en.bin` (PHA-3228) | `whisper` container, model on a host mount | `/opt/whisper`, weights **baked into the image** |
| ffmpeg, yt-dlp (PHA-3176) | nowhere — never installed | `/usr/local/bin`, exported at `/opt/sexton-tools` |
| bgutil POT provider | nowhere | `/opt/bgutil-pot`, served on `:4416` |
| supervisor | n/a (one process per container) | `supervisord` as PID 1 |

Three containers become one. `image/deploy.sh` removes `ts-bridge` and
`whisper` as part of deploying, because leaving `whisper` up would mean two
transcribers and a real chance the gateway is still pointed at the stale one.

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

**We picked (b).** It doubles the gateway's config burden, and it does so in the
literal sense the escape hatch was written for — not "adds some config", but
"there are now two gateways":

1. **Two gateway configs, two upgrade paths.** A second `openclaw` needs its own
   config file, data dir, agent identity, workspace, memory, and model-provider
   credentials. PHA-3326's whole finding was that a core version bump does not
   update managed channel plugins, so every OpenClaw upgrade would have to be
   performed and verified twice, in two places, forever.
2. **The main gateway already has it, working.** `openclaw channels status` on
   the box reports `teamspeak default: enabled, configured, running, connected`
   today, installed via the PHA-3326 `--link` path. (a) means tearing that out
   and rebuilding it inside a container whose own reason to exist is the audio
   lane.
3. **It is not actually a sidecar.** The thing (b) leaves outside is the
   pre-existing OpenClaw gateway that also runs Discord, Signal and WhatsApp.
   It is not a piece of the Sexton stack that we declined to fold in; it is
   unrelated infrastructure that the Sexton is one channel of. Under (b) the
   Sexton stack is exactly one container and one Unraid entry, which is what
   the decision asked for.
4. **OpenClaw is already on `phattvip`.** No network change is needed for the
   gateway to reach `ws://sexton:9099` and `http://sexton:8080/inference` by
   container name.

### The one thing (b) costs, and how the image pays it

`ffmpeg` and `yt-dlp` are spawned **by the plugin**, in the gateway process —
see `src/tools/music.ts` and `src/voice/speech.ts` in
`openclaw-teamspeak-plugin`. The gateway image has neither installed (checked:
`which ffmpeg yt-dlp` inside the running `OpenClaw` container returns nothing),
which is why the music lane and the TTS decode path have never actually worked
there. Putting them only inside this container would not fix that — they would
be sitting next to a process that never calls them.

So the image **exports** them at `/opt/sexton-tools`, and the deploy copies that
directory onto the host for the gateway to bind-mount:

```bash
docker cp sexton:/opt/sexton-tools/. /mnt/user/appdata/sexton/tools/
# then: Unraid -> Docker -> OpenClaw -> Edit -> add path mapping
#       /mnt/user/appdata/sexton/tools -> /opt/sexton-tools (read-only)
```

and the plugin is pointed at them with `tools.music.ytdlpPath` /
`ffmpegPath`. This keeps the property that matters — the versions the plugin
spawns are the versions this image pinned and `build.sh` verified — without a
custom gateway image, and it survives core bumps the same way the `--link`
plugin install does.

The POT provider needs none of that: it is an HTTP service, so it runs here and
the gateway's `yt-dlp` reaches it at `http://sexton:4416`.

`config.ts`'s comment that the POT provider is "an image concern, not a plugin
concern" was written when PHA-3306's custom-gateway-image plan was still alive.
That plan is dead; this is its replacement.

## Ports

`9099` bridge WebSocket · `8080` whisper · `4416` POT provider.

**None of them is published to the host.** The local STT lane exists so the
channel's audio does not leave the box, and a published port is the easiest way
to lose that by accident. Everything reaches them by container name on
`phattvip`.

## Superseded

- `sexton/Dockerfile` — kept for the CI compile check only; the deployed image
  is built from `image/Dockerfile`.
- `sexton/deploy/deploy.sh`, `sexton/deploy/sexton-compose.yml` — replaced by
  `image/deploy.sh` / `image/unraid-sexton.xml`.
- `whisper/deploy.sh`, `whisper/whisper-compose.yml` — the sidecar is gone.
  `whisper/verify.sh` still works if you point it at the `sexton` container.
- The multi-container deploy steps in PHA-3220 and PHA-3306.
