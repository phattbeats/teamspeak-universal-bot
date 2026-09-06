# Installing the TeamSpeak plugin on PHATT-RAID

The plugin README's install is the generic one (`docker compose build` in a
checkout). This is the same install against the box the Sexton actually runs
on, with the four ways that box differs already accounted for. State verified
2026-09-06.

## What is already true on the box

- **The Gateway runs a prebuilt release image** — `ghcr.io/openclaw/openclaw:2026.7.1`,
  container `OpenClaw`, managed by the Unraid template
  `/boot/config/plugins/dockerMan/templates-user/my-OpenClaw.xml`.
- Config lives at `/mnt/cache/appdata/openclaw/config/openclaw.json` (mounted at
  `/root/.openclaw`; the container runs as root, not the upstream compose's `node`).
- It is already on **both** `phattclaw-network` and `phattvip`, so it can reach
  the bridge by container name.
- **ts-bridge is already up** on `phattvip` (172.19.0.51:9099, nick `Sexton-Bridge`,
  channel `General Shit`, its own pinned `TS_IDENTITY`). Step 4 of PHA-3220 is done.
- Unraid has **no `docker compose`** and no host `node`/`python3`. Compose files
  there are documentation; read the config with `docker exec OpenClaw node -e '…'`.
- `/var/lib/docker` is 91% full (~44G free). The build script refuses under 25G;
  `docker image prune` reclaims ~12G of dangling layers.

## Why the running image can't just load the plugin

Neither config nor `openclaw plugins install <path>` can add it. The plugin
imports `openclaw/plugin-sdk/realtime-voice`, which the SDK itself labels a
*"Production-private runtime seam for bundled and separately published official
plugins."* It is exported from the root package's `dist/`, and the runtime image
has no `/app/node_modules/openclaw` for an out-of-tree plugin directory to
resolve it through. `OPENCLAW_EXTRA_MOUNTS` doesn't help either — it overrides an
*already packaged* plugin of the same id, and `teamspeak` isn't in the release
image. So: source-built image, which is also the first thing that typechecks
`src/channel.ts` against the real SDK.

The three realtime voice providers (`openai`, `google`, `xai`) are bundled by
default, so `OPENCLAW_EXTENSIONS=teamspeak` selects the plugin without dropping
them.

## 1. Build the image (on the RAID)

`plnt-sexton` is private and the RAID has no GitHub credential (OpenClaw's own
repo is public and clones fine), so stage the plugin directory onto the box and
point the script at it:

```bash
cd plnt-sexton/extensions
tar -cz teamspeak | ssh root@10.0.0.100 \
  'mkdir -p /mnt/cache/appdata/openclaw/src/staged && tar -C /mnt/cache/appdata/openclaw/src/staged -xz'
scp teamspeak/install/build-openclaw-teamspeak.sh root@10.0.0.100:/root/
ssh root@10.0.0.100 \
  'PLUGIN_SRC=/mnt/cache/appdata/openclaw/src/staged/teamspeak bash /root/build-openclaw-teamspeak.sh'
```

(With a GitHub credential on the box, drop `PLUGIN_SRC` and the script clones
plnt-sexton itself.) It clones OpenClaw at the commit the plugin was written
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

## 2. Point the container at it

Unraid GUI → Docker → `OpenClaw` → Edit → **Repository** =
`phattbeats/openclaw-sexton:teamspeak` → Apply. That recreates the container with
every existing env var, mount and port intact. Rollback is the same field set
back to `ghcr.io/openclaw/openclaw:2026.7.1`.

## 3. Configure the channel

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

## 4. The one prerequisite the box does not have

**A realtime provider credential.** `auth.profiles` holds Anthropic only, and
`models.providers.openai` on this box points at `https://chatgpt.com/backend-api/codex`
— a ChatGPT backend, not the Realtime API. A realtime session needs a key for
one of the bundled providers: OpenAI (`gpt-realtime-*`), Google, or xAI. Without
it the channel loads, `!sexton status` answers, and every speaker session fails
to open.

## 5. Verify

```bash
docker logs OpenClaw --since 5m 2>&1 | grep -i teamspeak   # channel start + bridge connect
```

Then in the channel: `!sexton status` should report bridge/channel/session/
wake-name/barge-in state. After that, PHA-3220's acceptance list.

If the bridge socket doesn't connect, resolve the name first — `docker exec
OpenClaw getent hosts ts-bridge` — and fall back to `ws://172.19.0.51:9099`.
