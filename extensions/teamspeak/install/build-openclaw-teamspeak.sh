#!/usr/bin/env bash
# Build an OpenClaw gateway image with extensions/teamspeak compiled in.
#
# Run this ON PHATT-RAID (10.0.0.100). Unraid has docker but no compose plugin,
# so this is `docker build`, not the `docker compose build` the plugin README
# gives for a normal checkout. See INSTALL-PHATT-RAID.md for the deploy that
# follows it.
set -euo pipefail

SRC_ROOT=${SRC_ROOT:-/mnt/cache/appdata/openclaw/src}
# The plugin was written against this commit (the vendored audio-codec copy in
# test/sdk-stubs is pinned to it). Bump both together.
OPENCLAW_REF=${OPENCLAW_REF:-fc1877d7f333a3546d8422956bbdb179f2cfc6cf}
SEXTON_REF=${SEXTON_REF:-main}
IMAGE=${IMAGE:-phattbeats/openclaw-sexton:teamspeak}
MIN_FREE_GB=${MIN_FREE_GB:-25}
# Set to "ffmpeg" (plus a pip install of yt-dlp) when the PHA-3176 music tools
# go live; the plugin's other tools and all of PHA-3220 need neither binary.
IMAGE_APT_PACKAGES=${IMAGE_APT_PACKAGES:-}

log() { printf '\n== %s\n' "$*"; }

log "preflight"
command -v docker >/dev/null || { echo "no docker on PATH"; exit 1; }
free_gb=$(df -BG --output=avail /var/lib/docker | tail -1 | tr -dc '0-9')
echo "free on /var/lib/docker: ${free_gb}G (want >= ${MIN_FREE_GB}G)"
if [ "${free_gb:-0}" -lt "$MIN_FREE_GB" ]; then
  echo "not enough room for the build; 'docker image prune' reclaims the dangling layers" >&2
  exit 1
fi
mkdir -p "$SRC_ROOT"

log "openclaw source @ ${OPENCLAW_REF}"
if [ ! -d "$SRC_ROOT/openclaw/.git" ]; then
  git clone --filter=blob:none https://github.com/openclaw/openclaw.git "$SRC_ROOT/openclaw"
fi
git -C "$SRC_ROOT/openclaw" fetch --filter=blob:none origin "$OPENCLAW_REF" \
  || git -C "$SRC_ROOT/openclaw" fetch origin
git -C "$SRC_ROOT/openclaw" checkout --force "$OPENCLAW_REF"

# plnt-sexton is a private repo and the RAID has no GitHub credential, so the
# usual path is to stage the plugin directory onto the box first:
#   tar -C plnt-sexton/extensions -cz teamspeak | ssh root@10.0.0.100 \
#     'mkdir -p /mnt/cache/appdata/openclaw/src/staged && tar -C /mnt/cache/appdata/openclaw/src/staged -xz'
#   PLUGIN_SRC=/mnt/cache/appdata/openclaw/src/staged/teamspeak ./build-openclaw-teamspeak.sh
# Set PLUGIN_SRC to skip the clone. With a credential on the box, leave it unset.
PLUGIN_SRC=${PLUGIN_SRC:-}
if [ -z "$PLUGIN_SRC" ]; then
  log "plnt-sexton @ ${SEXTON_REF}"
  if [ ! -d "$SRC_ROOT/plnt-sexton/.git" ]; then
    git clone https://github.com/phattbeats/plnt-sexton.git "$SRC_ROOT/plnt-sexton"
  fi
  git -C "$SRC_ROOT/plnt-sexton" fetch origin
  git -C "$SRC_ROOT/plnt-sexton" checkout --force "origin/${SEXTON_REF}"
  PLUGIN_SRC="$SRC_ROOT/plnt-sexton/extensions/teamspeak"
fi
[ -f "$PLUGIN_SRC/openclaw.plugin.json" ] || { echo "no plugin at $PLUGIN_SRC" >&2; exit 1; }

log "copy the plugin into the checkout (from $PLUGIN_SRC)"
dest="$SRC_ROOT/openclaw/extensions/teamspeak"
rm -rf "$dest"
cp -a "$PLUGIN_SRC" "$dest"
# Standalone-only scaffolding. Inside a checkout the real SDK resolves, the
# repo's own vitest runs the tests, and node_modules/ would only bloat the
# build context (README, "Using it in an OpenClaw checkout").
rm -rf "$dest/node_modules" "$dest/test/sdk-stubs" "$dest/vitest.standalone.config.ts" \
       "$dest/package-lock.json" "$dest/install"
printf '{ "extends": "../tsconfig.package-boundary.base.json" }\n' > "$dest/tsconfig.json"

log "build ${IMAGE}"
cd "$SRC_ROOT/openclaw"
docker build \
  --build-arg "OPENCLAW_EXTENSIONS=teamspeak" \
  --build-arg "OPENCLAW_IMAGE_APT_PACKAGES=${IMAGE_APT_PACKAGES}" \
  --build-arg "GIT_COMMIT=$(git rev-parse HEAD)" \
  -t "$IMAGE" .

log "verify the plugin actually landed in the image"
# Not the build exit code: a green build of the wrong tag has fooled us before.
docker run --rm --entrypoint sh "$IMAGE" -c 'ls /app/dist/extensions | grep -qx teamspeak' \
  && echo "ok: /app/dist/extensions/teamspeak present in ${IMAGE}"
