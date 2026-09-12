#!/bin/sh
# PHA-3428 option (a): the Sexton's own OpenClaw gateway, in-container.
#
# Brandon, 2026-09-12: "this container runs its own OpenClaw gateway instance
# with the teamspeak plugin installed via the PHA-3326 managed install. Do not
# wire the bridge socket out to the main gateway."
#
# Three things happen here, in order, on every boot:
#
#   1. Seed the config if there isn't one. The seed already contains the
#      teamspeak channel block pointed at 127.0.0.1 — under option (a) the
#      bridge, whisper and the POT provider are all in this same container, so
#      none of the container-name URLs from the (b) era apply.
#   2. `openclaw plugins install --link`. Idempotent by design and re-run every
#      boot on purpose: the install record lives in the mounted state dir, so
#      running it here (rather than at build time, where the volume is not yet
#      mounted) is what makes a fresh /config self-install and an image bump not
#      need a manual reinstall. PHA-3326: `--link` is the ONLY install form this
#      plugin works under — `git:` fails on it and a plain path install fails
#      the built-runtime-entry check, because the plugin ships TypeScript.
#   3. exec the gateway.
#
# Credentials are NOT baked. They arrive as env (ANTHROPIC_API_KEY and friends)
# or in the imported models/auth blocks that image/deploy.sh copies from the
# main gateway. Nothing here writes a secret into the image.
set -eu

: "${OPENCLAW_STATE_DIR:=/config/openclaw}"
: "${OPENCLAW_CONFIG_PATH:=${OPENCLAW_STATE_DIR}/openclaw.json}"
: "${SEXTON_PLUGIN_DIR:=/opt/openclaw-teamspeak-plugin}"
: "${SEXTON_GATEWAY_PORT:=18789}"
: "${SEXTON_GATEWAY_BIND:=lan}"
: "${SEXTON_GATEWAY_ENABLED:=1}"
export OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH

if [ "$SEXTON_GATEWAY_ENABLED" != "1" ]; then
  # The escape hatch for a rollback to (b) without rebuilding: set
  # SEXTON_GATEWAY_ENABLED=0 and re-point the main gateway at ws://sexton:9099.
  # Exits 0 so supervisord's `autorestart=unexpected` leaves it down.
  echo "run-gateway: disabled by SEXTON_GATEWAY_ENABLED=0 — no in-container gateway."
  exit 0
fi

mkdir -p "$OPENCLAW_STATE_DIR"

# --- 1. seed ---
if [ ! -s "$OPENCLAW_CONFIG_PATH" ]; then
  echo "run-gateway: no config at $OPENCLAW_CONFIG_PATH — seeding from /opt/sexton-gateway/openclaw.seed.json"
  # envsubst is not installed and the substitutions are few, so: node, which is
  # certainly here (this is the gateway's own base image). Writing through node
  # also means a malformed seed fails loudly at boot instead of producing a
  # half-written config the gateway then refuses.
  node -e '
    const fs = require("fs");
    const seed = JSON.parse(fs.readFileSync("/opt/sexton-gateway/openclaw.seed.json", "utf8"));
    const env = process.env;
    seed.channels.teamspeak.channel = env.SEXTON_CHANNEL || seed.channels.teamspeak.channel;
    seed.channels.teamspeak.bridgeUrl = `ws://127.0.0.1:${(env.SEXTON_WS_BIND || "0.0.0.0:9099").split(":").pop()}`;
    seed.channels.teamspeak.voice.streaming.transcription.url =
      `http://127.0.0.1:${env.WHISPER_PORT || 8080}/inference`;
    seed.channels.teamspeak.tools.music.extraYtdlpArgs = [
      "--extractor-args",
      `youtubepot-bgutilhttp:base_url=http://127.0.0.1:${env.POT_PORT || 4416}`,
    ];
    seed.gateway.port = Number(env.SEXTON_GATEWAY_PORT || 18789);
    fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(seed, null, 2) + "\n");
  '
  chmod 0600 "$OPENCLAW_CONFIG_PATH"
fi

# --- 1b. consume a staged credentials import ---
# image/deploy.sh drops credentials.import.json here rather than merging it
# itself, because the merge has to happen AFTER the seed above — the seed is
# the only thing that knows this container's env. Consumed once and deleted, so
# a later hand-edit of openclaw.json is never silently overwritten on the next
# restart.
IMPORT_FILE="${OPENCLAW_STATE_DIR}/credentials.import.json"
if [ -s "$IMPORT_FILE" ]; then
  echo "run-gateway: merging staged credentials from $IMPORT_FILE"
  node -e '
    const fs = require("fs");
    const cfgPath = process.env.OPENCLAW_CONFIG_PATH;
    const impPath = process.argv[1];
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const imp = JSON.parse(fs.readFileSync(impPath, "utf8"));
    // Top-level block replace, and channels/gateway are never importable —
    // deploy.sh already filters them out, but this is the load-bearing
    // invariant (importing the main gateway`s channels would start Discord,
    // Signal and WhatsApp in here) so it is asserted on both sides.
    for (const [k, v] of Object.entries(imp)) {
      if (k === "channels" || k === "gateway" || k === "plugins") continue;
      cfg[k] = v;
    }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    console.log("run-gateway: merged " + Object.keys(imp).join(", "));
  ' "$IMPORT_FILE"
  chmod 0600 "$OPENCLAW_CONFIG_PATH"
  rm -f "$IMPORT_FILE"
fi

# A config with no model credentials starts, joins the channel, and then says
# nothing — the failure mode that looks like a dead bot but is a green
# healthcheck. Say so at boot rather than leaving it to be discovered in the
# room. Not fatal: the voice lane and the bridge still come up, and an operator
# can drop credentials in and restart just this program.
if ! grep -q '"apiKey"\|"models"' "$OPENCLAW_CONFIG_PATH" 2>/dev/null \
   && [ -z "${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}${MINIMAX_API_KEY:-}" ]; then
  echo "run-gateway: WARNING — no model credentials in $OPENCLAW_CONFIG_PATH and none in env." >&2
  echo "run-gateway:           The Sexton will join the channel and not answer." >&2
  echo "run-gateway:           Run image/deploy.sh's --import-gateway-config step." >&2
fi

# --- 2. the PHA-3326 managed link install ---
if [ -f "$SEXTON_PLUGIN_DIR/openclaw.plugin.json" ]; then
  echo "run-gateway: linking the teamspeak plugin from $SEXTON_PLUGIN_DIR"
  # --force so a re-run over an existing record is a no-op rather than an
  # error; --accept-capabilities because this is an unattended boot and the
  # plugin's capability prompt would otherwise block forever on a TTY that
  # isn't there.
  openclaw plugins install --link "$SEXTON_PLUGIN_DIR" --force --accept-capabilities \
    || echo "run-gateway: WARNING — plugin link install failed; the channel will not load." >&2
else
  echo "run-gateway: WARNING — no plugin at $SEXTON_PLUGIN_DIR." >&2
fi

# --- 3. the gateway ---
echo "run-gateway: openclaw gateway --bind $SEXTON_GATEWAY_BIND --port $SEXTON_GATEWAY_PORT (state: $OPENCLAW_STATE_DIR)"
exec openclaw gateway --bind "$SEXTON_GATEWAY_BIND" --port "$SEXTON_GATEWAY_PORT"
