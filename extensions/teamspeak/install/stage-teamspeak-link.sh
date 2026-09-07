#!/usr/bin/env bash
# Stage extensions/teamspeak on the Gateway host for a managed `--link` install
# (PHA-3326). No custom image, no build step: the plugin ships TypeScript
# directly and `openclaw plugins install --link` is exempt from the
# built-runtime-entry check that a plain `install <path>`/npm/npm-pack install
# would fail without a compiled dist/. This is the whole point of the switch
# away from build-openclaw-teamspeak.sh's custom image.
#
# Requires OpenClaw >=2026.9.2 (extensions/teamspeak/package.json#compat) --
# older cores can't resolve the `openclaw/plugin-sdk/*` production-private
# subpaths from an out-of-tree plugin directory. Verified against 2026.7.1
# (fails: "Cannot find module 'openclaw/plugin-sdk/realtime-voice'"-class
# resolution failure surfaced as a plugin-API compat gate) and 2026.9.2
# (resolves; see INSTALL-PHATT-RAID.md).
#
# Run this ON the Gateway host. Unraid has no docker compose, so dependency
# install below runs through the Gateway's own image (it has node/npm; the
# host does not).
set -euo pipefail

DEST=${DEST:-/mnt/cache/appdata/openclaw/plugins/teamspeak}
SEXTON_REF=${SEXTON_REF:-main}
GATEWAY_IMAGE=${GATEWAY_IMAGE:-ghcr.io/openclaw/openclaw:latest}

log() { printf '\n== %s\n' "$*"; }

# plnt-sexton is a private repo; stage the plugin directory onto the box first
# (from a checkout, not this script) unless PLUGIN_SRC is already staged:
#   tar -C plnt-sexton/extensions -cz teamspeak | ssh root@<host> \
#     'mkdir -p /mnt/cache/appdata/openclaw/src/staged && tar -C /mnt/cache/appdata/openclaw/src/staged -xz'
#   PLUGIN_SRC=/mnt/cache/appdata/openclaw/src/staged/teamspeak ./stage-teamspeak-link.sh
PLUGIN_SRC=${PLUGIN_SRC:-}
if [ -z "$PLUGIN_SRC" ]; then
  log "plnt-sexton @ ${SEXTON_REF}"
  SRC_ROOT=${SRC_ROOT:-/mnt/cache/appdata/openclaw/src}
  mkdir -p "$SRC_ROOT"
  if [ ! -d "$SRC_ROOT/plnt-sexton/.git" ]; then
    git clone https://github.com/phattbeats/plnt-sexton.git "$SRC_ROOT/plnt-sexton"
  fi
  git -C "$SRC_ROOT/plnt-sexton" fetch origin
  git -C "$SRC_ROOT/plnt-sexton" checkout --force "origin/${SEXTON_REF}"
  PLUGIN_SRC="$SRC_ROOT/plnt-sexton/extensions/teamspeak"
fi
[ -f "$PLUGIN_SRC/openclaw.plugin.json" ] || { echo "no plugin at $PLUGIN_SRC" >&2; exit 1; }

log "copy the plugin to ${DEST}"
rm -rf "$DEST"
cp -a "$PLUGIN_SRC" "$DEST"
# Standalone-only scaffolding (README, "Installing as a managed plugin"). The
# real SDK resolves against the linked-in host package once OpenClaw restarts,
# so the test stubs would just be dead weight in a runtime install.
rm -rf "$DEST/node_modules" "$DEST/test/sdk-stubs" "$DEST/vitest.standalone.config.ts"

log "install runtime dependencies (ws) via the Gateway image's node/npm"
docker run --rm -v "$DEST:/mnt/plugin" -w /mnt/plugin --entrypoint sh "$GATEWAY_IMAGE" \
  -c "npm install --omit=dev --no-audit --no-fund"

cat <<EOF

== staged ==
${DEST}

Remaining steps (manual — these touch the running container):
1. Add a permanent bind mount to the Gateway container:
     ${DEST} -> /plugins/teamspeak (or any container path), read-only is fine.
   Unraid: Docker tab -> OpenClaw -> Edit -> add Path mapping -> Apply.
2. Confirm the Gateway core is >=2026.9.2 (openclaw --version inside the
   container). Upgrade first if not; this install path depends on it.
3. Install and enable:
     docker exec OpenClaw openclaw plugins install --link /plugins/teamspeak --force --accept-capabilities
4. Add the "teamspeak" block under channels in openclaw.json (see README.md)
   and restart the Gateway to load it.

Because the plugin now lives in the mounted host directory and the install
record lives in the Gateway's own persisted config/state dir, both survive
\`openclaw update\` / a base-image pull with no re-deploy step -- unlike the
old build-openclaw-teamspeak.sh custom image, which an image pull wipes.
EOF
