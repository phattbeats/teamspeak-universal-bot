# Installing the TeamSpeak plugin on PHATT-RAID

State verified 2026-09-07 (PHA-3326). **The recommended path is now the
managed `--link` plugin install below, not the custom-image build** — a
custom image gets silently wiped by the next `openclaw update`/base-image
pull, a managed install does not. The custom-image path (originally written
2026-09-06 for PHA-3220) is kept further down as a fallback/dev option.

**Update 2026-09-07, post PHA-3220 repo split:** this plugin moved out of
`plnt-sexton` into its own repo, `phattbeats/openclaw-teamspeak-plugin`. The
staging recipe below now clones/tars from that repo, not `plnt-sexton`. A
`git:` install straight from the new repo was also re-tested and still fails
on the same missing-`dist/` wall `npm-pack:` hit before the split (see
README's "Installing as a managed plugin" section) — `--link` is still the
only working install source. The plugin has already been re-staged from the
new repo at `/mnt/cache/appdata/openclaw/plugins/teamspeak` (the prior
plnt-sexton-era staged copy is kept alongside as
`teamspeak.orphaned-plnt-sexton-era` for reference, not in the mount path)
and re-validated `--link`-loading clean (`"status": "loaded"`, `"imported":
true`) against `ghcr.io/openclaw/openclaw:latest` (2026.9.2) in a scratch
container.

**Update 2026-09-09: the live production cutover below is done.** Brandon
accepted the cutover confirmation on PHA-3326 (2026-09-07). The Gateway core
is now `ghcr.io/openclaw/openclaw:2026.9.3`; the plugin is `--link`-installed
and loads clean (`openclaw plugins inspect teamspeak --runtime --json` reports
`"imported": true`); and the `/plugins/teamspeak` Path mapping is a permanent
fixture of `my-OpenClaw.xml` (not just a one-time manual container edit), so
it now survives an Unraid "Update Container" the same as any other mount.
Along the way, the version-bump migration hit an unrelated OpenClaw bug worth
recording: a crashed prior migration attempt left an unexpired
`state_leases` row (`scope=startup-migrations`) that no restart could ever
reacquire — `openclaw doctor --fix` does not detect or clear it. Fix was a
direct `DELETE FROM state_leases WHERE scope='startup-migrations'` against
`openclaw.sqlite` (config backed up first) before restarting; see the
PHA-3326 comment thread for the full diagnosis. The `channels.teamspeak`
config block below is **not** applied yet — that's PHA-3220's live-voice
verification pass, tracked separately and not required for this issue.

## What is already true on the box

- **The Gateway runs a prebuilt release image** — `ghcr.io/openclaw/openclaw:2026.9.3`,
  container `OpenClaw`, managed by the Unraid template
  `/boot/config/plugins/dockerMan/templates-user/my-OpenClaw.xml`. The
  managed `--link` install is live and loaded (verified via `openclaw plugins
  inspect teamspeak --runtime --json` and `openclaw plugins list`); the
  `channels.teamspeak` block has not been added yet, so the channel itself
  isn't configured (see PHA-3220 for that pass).
- Config lives at `/mnt/cache/appdata/openclaw/config/openclaw.json` (mounted at
  `/root/.openclaw`; the container runs as root, not the upstream compose's `node`).
- It is already on **both** `phattclaw-network` and `phattvip`, so it can reach
  the bridge by container name.
- **ts-bridge is already up** on `phattvip` (172.19.0.51:9099, nick `Sexton-Bridge`,
  channel `General Shit`, its own pinned `TS_IDENTITY`). Step 4 of PHA-3220 is done.
- The live Gateway also serves **Discord and Signal** right now (`channels` in
  the live config). Any of the steps below that restart the container —
  cutting to a new image, or a managed plugin install — briefly interrupts
  those too, not just teamspeak.
- Unraid has **no `docker compose`** and no host `node`/`python3`. Compose files
  there are documentation; read the config with `docker exec OpenClaw node -e '…'`.
- `/var/lib/docker` is 88% full (~59G free, after a prune). The build script
  refuses under 25G.
- **`/mnt/cache` (the appdata pool, `/dev/sdh1`) is at 95% (~13G free as of
  2026-09-09)** — noticeably worse than the `/var/lib/docker` figure above and
  climbing. It caused transient `SQLite read-only worker EIO`/disk-I/O errors
  during the `--link` install here (retrying the same command succeeded a
  moment later). Worth a cleanup pass or expansion before it starts failing
  writes outright; not this issue's scope to fix.

## The managed `--link` install (PHA-3326)

**Done on this box as of 2026-09-09 — steps 1-3 below are the historical
recipe, kept for rebuilding from scratch.** This needs the Gateway core at
>=2026.9.2 first. Before the cutover the running image was
2026.7.1 (7 weeks old); a plain `plugins install` against it fails outright on
a plugin-API compat check (`plugin "teamspeak" requires plugin API
>=2026.9.2, but this OpenClaw runtime exposes 2026.7.1`) before it even gets
to loading plugin code. That version floor isn't arbitrary — it's exactly
where `openclaw/plugin-sdk/*` production-private subpath resolution for an
out-of-tree (non-bundled) plugin directory starts working. Confirmed by
direct test in a scratch container against both versions:

```bash
# 2026.7.1 (current prod image): fails on the plugin-API compat gate above.
# 2026.9.2 (ghcr.io/openclaw/openclaw:latest, tested 2026-09-07): installs,
# loads index.ts -> src/channel.ts and the bridge/runtime modules that import
# openclaw/plugin-sdk/{realtime-voice,config-contracts,runtime-env}, and
# `openclaw plugins inspect teamspeak --runtime` reports "imported": true.
```

So the old note that the SDK subpaths are unreachable from outside the image
was true for 2026.7.1 and is no longer true once the core is current — that
finding is what makes this whole install path viable. There is still no
special mount needed (`OPENCLAW_EXTRA_MOUNTS` remains irrelevant either way).

### 1. Upgrade the Gateway core

Back the config up first — this is the same schema-bearing upgrade the old
image-build path also required:

```bash
cp -a /mnt/cache/appdata/openclaw/config /mnt/cache/appdata/openclaw/config.bak-$(date +%F)
```

Unraid GUI → Docker → `OpenClaw` → Edit → **Repository** =
`ghcr.io/openclaw/openclaw:latest` (or a pinned `2026.9.x` tag) → Apply.
Rollback is the same field set back to `ghcr.io/openclaw/openclaw:2026.7.1`.

### 2. Stage the plugin and add the mount

```bash
cd openclaw-teamspeak-plugin   # a checkout of phattbeats/openclaw-teamspeak-plugin;
                                # it's a private repo and the box has no stored
                                # GitHub credential, so push a checkout over
                                # rather than cloning on-box
tar -cz --exclude=.git --exclude=node_modules . | ssh root@10.0.0.100 \
  'mkdir -p /mnt/cache/appdata/openclaw/src/staged/teamspeak && tar -C /mnt/cache/appdata/openclaw/src/staged/teamspeak -xz'
ssh root@10.0.0.100 \
  'PLUGIN_SRC=/mnt/cache/appdata/openclaw/src/staged/teamspeak bash /mnt/cache/appdata/openclaw/src/staged/teamspeak/install/stage-teamspeak-link.sh'
```

This stages a runtime-ready copy at `/mnt/cache/appdata/openclaw/plugins/teamspeak`
(test suite stripped, `ws` installed via the Gateway image's own npm — see
the script for why the host can't run npm itself). Already done once against
this exact box as part of PHA-3326's verification (re-staged from the new
repo after the PHA-3220 split, `--link`-validated clean in a scratch
container); re-run after any plugin source change.

Then, Unraid GUI → Docker → `OpenClaw` → Edit → add a **Path** mapping:
Container Path `/plugins/teamspeak` → Host Path
`/mnt/cache/appdata/openclaw/plugins/teamspeak` (read-only) → Apply. This is
the one part of the setup that has to be a permanent fixture of the container
definition — the option 1 tradeoff called out on PHA-3326. Done as of
2026-09-09 by editing `my-OpenClaw.xml` directly (a `Path` Config entry,
`Mode="ro,slave"`) rather than through the GUI; either way lands in the same
template file, so it now persists across an Unraid "Update Container" the
same as `/root/.openclaw`, `/tmp`, and `/root/.cache` already did.

### 3. Install and configure

```bash
docker exec OpenClaw openclaw plugins install --link /plugins/teamspeak --force --accept-capabilities
```

Then add the `channels.teamspeak` block from "Configure the channel" below to
`openclaw.json` and restart the Gateway (`docker restart OpenClaw`, or let the
plugin install's own auto-restart pick it up).

### Why this survives updates and the old image build didn't

The plugin code is a bind mount (host directory, not image layer) and the
install record lives in `/mnt/cache/appdata/openclaw/config` (already a
persistent volume, not image state). An `openclaw update` or a base-image
pull replaces `/app` inside the container; it does not touch either of those,
so the plugin keeps loading with no re-deploy step. The custom
`phattbeats/openclaw-sexton:teamspeak` image below has the plugin compiled
into `/app/dist` itself — the first image pull silently reverts to whatever
image the Repository field names, which is exactly the failure mode PHA-3326
exists to close.

## Fallback: build a custom image

Kept for local dev or a from-scratch CI build; not recommended for this box
per the survives-updates argument above.

`openclaw-teamspeak-plugin` is private and the RAID has no GitHub credential
(OpenClaw's own repo is public and clones fine), so stage the plugin
directory onto the box and point the script at it:

```bash
cd openclaw-teamspeak-plugin   # a checkout of phattbeats/openclaw-teamspeak-plugin
tar -cz --exclude=.git . | ssh root@10.0.0.100 \
  'mkdir -p /mnt/cache/appdata/openclaw/src/staged/teamspeak && tar -C /mnt/cache/appdata/openclaw/src/staged/teamspeak -xz'
scp install/build-openclaw-teamspeak.sh root@10.0.0.100:/root/
ssh root@10.0.0.100 \
  'PLUGIN_SRC=/mnt/cache/appdata/openclaw/src/staged/teamspeak bash /root/build-openclaw-teamspeak.sh'
```

(With a GitHub credential on the box, drop `PLUGIN_SRC` and the script clones
`openclaw-teamspeak-plugin` itself.) It clones OpenClaw at the commit the plugin was written
against, copies the plugin
in with the two standalone-only adjustments the README lists, builds
`phattbeats/openclaw-sexton:teamspeak`, and then checks
`/app/dist/extensions/teamspeak` exists *in the built image* rather than trusting
the build's exit code.

Back the config up first — this also moves the Gateway from 2026.7.1 (7 weeks
old) to current main, which is a schema-bearing upgrade in its own right:

```bash
cp -a /mnt/cache/appdata/openclaw/config /mnt/cache/appdata/openclaw/config.bak-$(date +%F)
```

Then Unraid GUI → Docker → `OpenClaw` → Edit → **Repository** =
`phattbeats/openclaw-sexton:teamspeak` → Apply. That recreates the container with
every existing env var, mount and port intact. Rollback is the same field set
back to `ghcr.io/openclaw/openclaw:2026.7.1`.

## Configure the channel (either install path)

Add to `/mnt/cache/appdata/openclaw/config/openclaw.json` under `channels`
(there is no Discord voice block on this box to copy from — this is the whole
block):

```jsonc
"teamspeak": {
  "bridgeUrl": "ws://ts-bridge:9099",
  "channel": "General Shit",
  "tools": { "enabled": false },   // PHA-3176; needs yt-dlp+ffmpeg in the image
  "voice": {
    "enabled": true,
    "mode": "agent-proxy",
    "agentSession": { "mode": "voice" },
    "realtime": {
      "provider": "openai",
      "model": "gpt-realtime-2.1",
      "speakerVoice": "cedar",
      "wakeNames": ["sexton"],
      "bargeIn": true,
      "minBargeInAudioEndMs": 250
    }
  }
}
```

Leave `requireWakeName` unset — unset *is* the automatic policy PHA-3220's
acceptance tests (no wake name alone, wake name once a second human joins).

## The one prerequisite the box does not have

**A realtime provider credential.** `auth.profiles` holds Anthropic only, and
`models.providers.openai` on this box points at `https://chatgpt.com/backend-api/codex`
— a ChatGPT backend, not the Realtime API. A realtime session needs a key for
one of the bundled providers: OpenAI (`gpt-realtime-*`), Google, or xAI. Without
it the channel loads, `!sexton status` answers, and every speaker session fails
to open.

## Verify

```bash
docker logs OpenClaw --since 5m 2>&1 | grep -i teamspeak   # channel start + bridge connect
docker exec OpenClaw openclaw plugins inspect teamspeak --runtime --json   # "imported": true
```

Then in the channel: `!sexton status` should report bridge/channel/session/
wake-name/barge-in state. After that, PHA-3220's acceptance list.

If the bridge socket doesn't connect, resolve the name first — `docker exec
OpenClaw getent hosts ts-bridge` — and fall back to `ws://172.19.0.51:9099`.
