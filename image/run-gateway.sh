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

# The gateway token. The gateway refuses to bind without auth ("Refusing to
# bind gateway to lan without auth"), and the CLI needs the same credential to
# talk to it — including the `openclaw plugins install` below and the
# `openclaw channels status` the deploy script polls. Generated once, kept in
# the mounted state dir at 0600, and exported so every CLI call in this script
# and every `docker exec … openclaw …` after it just works.
TOKEN_FILE="${OPENCLAW_STATE_DIR}/gateway-token"
if [ ! -s "$TOKEN_FILE" ]; then
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$TOKEN_FILE"
  chmod 0600 "$TOKEN_FILE"
  echo "run-gateway: generated a new gateway token at $TOKEN_FILE"
fi
OPENCLAW_GATEWAY_TOKEN=$(cat "$TOKEN_FILE")
export OPENCLAW_GATEWAY_TOKEN

# --- 1. seed ---
#
# The teamspeak channel block is deliberately NOT written here. Config
# validation rejects `channels.teamspeak` with "unknown channel id: teamspeak"
# until the plugin that defines that channel is installed, and an invalid
# config makes `openclaw plugins install` refuse to run — so seeding the
# channel first deadlocks the very step that would make it valid. The block is
# applied in step 3, after the link install. This is the whole reason the boot
# sequence has the shape it does; do not fold the two back together.
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
    delete seed.channels;                       // applied after the plugin install
    seed.gateway.port = Number(env.SEXTON_GATEWAY_PORT || 18789);
    seed.gateway.bind = env.SEXTON_GATEWAY_BIND || seed.gateway.bind;
    seed.gateway.auth = { mode: "token", token: env.OPENCLAW_GATEWAY_TOKEN };
    fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(seed, null, 2) + "\n");
  '
  chmod 0600 "$OPENCLAW_CONFIG_PATH"
fi

# Keep the auth block in step with the token file even on an existing config —
# otherwise restoring a config backup without its token file leaves a gateway
# that will not bind and a CLI that cannot ask it why.
node -e '
  const fs = require("fs");
  const p = process.env.OPENCLAW_CONFIG_PATH;
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  cfg.gateway = cfg.gateway || {};
  const want = { mode: "token", token: process.env.OPENCLAW_GATEWAY_TOKEN };
  if (JSON.stringify(cfg.gateway.auth) !== JSON.stringify(want)) {
    cfg.gateway.auth = want;
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    console.log("run-gateway: refreshed gateway.auth from " + process.env.OPENCLAW_STATE_DIR + "/gateway-token");
  }
'

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

# --- 1c. a persona of our own (PHA-3554: Bexton) ---
#
# The sexton image is also the Bexton image: same binary, same bridge, same
# gateway, a different agent in the chair. SEXTON_AGENT_ID names the agent this
# container's teamspeak channel binds to, and SEXTON_PERSONA_DIR is a directory
# of workspace files (AGENTS.md, SOUL.md, IDENTITY.md) baked into the image for
# it. Both are first-boot seeds: the workspace is copied only if the agent has
# none yet, and the agent entry + binding are written only if absent, so an
# operator's later edits to either survive every restart.
#
# The model block is copied from whatever agent the imported config already
# routes teamspeak to (the Sexton, on this box), then from agents.defaults, so
# a new persona inherits the credentials that are known to work here rather
# than the main gateway's MiniMax-M3 default, which produces no speakable
# payload on this lane.
if [ -n "${SEXTON_AGENT_ID:-}" ] && [ "${SEXTON_AGENT_ID}" != "sexton" ]; then
  PERSONA_DIR="${SEXTON_PERSONA_DIR:-/opt/sexton-persona/${SEXTON_AGENT_ID}}"
  WS="${OPENCLAW_STATE_DIR}/workspace/agents/${SEXTON_AGENT_ID}"
  if [ ! -d "$WS" ] && [ -d "$PERSONA_DIR" ]; then
    echo "run-gateway: seeding the ${SEXTON_AGENT_ID} workspace from ${PERSONA_DIR}"
    mkdir -p "$WS"
    cp -a "$PERSONA_DIR"/. "$WS"/
  fi
  mkdir -p "$WS"
  node -e '
    const fs = require("fs");
    const p = process.env.OPENCLAW_CONFIG_PATH;
    const id = process.env.SEXTON_AGENT_ID;
    const ws = process.argv[1];
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    cfg.agents = cfg.agents || {};
    cfg.agents.entries = cfg.agents.entries || {};
    let changed = false;
    if (!cfg.agents.entries[id]) {
      const bound = (cfg.bindings || []).find((b) => b?.match?.channel === "teamspeak")?.agentId;
      const donor = (bound && cfg.agents.entries[bound]) || {};
      const name = process.env.SEXTON_NICK || id;
      cfg.agents.entries[id] = {
        name,
        workspace: ws,
        ...(donor.model ? { model: donor.model } : {}),
        identity: { name },
        thinkingDefault: "off",
        tools: { deny: ["process", "sessions_spawn"] },
      };
      console.log("run-gateway: added agents.entries." + id + (bound ? " (model from " + bound + ")" : ""));
      changed = true;
    }
    const want = { agentId: id, match: { channel: "teamspeak", accountId: "*" } };
    const bindings = (cfg.bindings || []).filter((b) => b?.match?.channel !== "teamspeak");
    const current = (cfg.bindings || []).find((b) => b?.match?.channel === "teamspeak");
    if (!current || current.agentId !== id) {
      cfg.bindings = [...bindings, want];
      console.log("run-gateway: bound channel teamspeak -> " + id);
      changed = true;
    }
    if (changed) fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  ' "$WS"
  chmod 0600 "$OPENCLAW_CONFIG_PATH"
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

# --- 3. the teamspeak channel block, now that the channel id exists ---
#
# Deferred from the seed: see the note in step 1. Only written if the config
# has no teamspeak block yet, so hand-edits survive every restart — this is a
# first-boot completion step, not a reconciler.
if ! node -e '
  const fs = require("fs");
  const cfg = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
  process.exit(cfg.channels && cfg.channels.teamspeak ? 0 : 1);
'; then
  echo "run-gateway: applying the teamspeak channel block (loopback)"
  node -e '
    const fs = require("fs");
    const p = process.env.OPENCLAW_CONFIG_PATH;
    const env = process.env;
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    const ts = JSON.parse(
      fs.readFileSync("/opt/sexton-gateway/openclaw.seed.json", "utf8")
    ).channels.teamspeak;
    ts.channel = env.SEXTON_CHANNEL || ts.channel;
    ts.bridgeUrl = `ws://127.0.0.1:${(env.SEXTON_WS_BIND || "0.0.0.0:9099").split(":").pop()}`;
    ts.voice.streaming.transcription.url =
      `http://127.0.0.1:${env.WHISPER_PORT || 8080}/inference`;
    ts.tools.music.extraYtdlpArgs = [
      "--extractor-args",
      `youtubepot-bgutilhttp:base_url=http://127.0.0.1:${env.POT_PORT || 4416}`,
    ];
    // Wake names follow the persona. Comma-separated; case variants are added
    // because the wake gate matches the transcript literally.
    if (env.SEXTON_WAKE_NAMES) {
      const names = env.SEXTON_WAKE_NAMES.split(",").map((n) => n.trim()).filter(Boolean);
      ts.voice.wakeNames = [...new Set(names.flatMap((n) => [n, n.toLowerCase()]))];
    }
    // The house band (PHA-3554). Opt-in, and the MiniMax key is the one the
    // TTS block already carries, so nobody types it twice.
    if (env.SEXTON_BAND_ENABLED === "1") {
      const provider = env.SEXTON_BAND_PROVIDER || "minimax";
      const band = {
        enabled: true,
        provider,
        songsDir: "/config/band-songs",
        ...(env.SEXTON_BAND_NAME ? { name: env.SEXTON_BAND_NAME } : {}),
      };
      const ttsKey = cfg.tts?.providers?.minimax?.apiKey;
      if (provider === "minimax") {
        band.minimax = {
          ...(env.SEXTON_BAND_MINIMAX_API_KEY || ttsKey
            ? { apiKey: env.SEXTON_BAND_MINIMAX_API_KEY || ttsKey }
            : {}),
          ...(env.SEXTON_BAND_MINIMAX_MODEL ? { model: env.SEXTON_BAND_MINIMAX_MODEL } : {}),
        };
      } else if (provider === "suno-api") {
        band.sunoApi = {
          ...(env.SEXTON_BAND_SUNO_API_URL ? { baseUrl: env.SEXTON_BAND_SUNO_API_URL } : {}),
          ...(env.SEXTON_BAND_SUNO_API_KEY ? { apiKey: env.SEXTON_BAND_SUNO_API_KEY } : {}),
        };
      } else if (provider === "command") {
        band.command = { path: env.SEXTON_BAND_COMMAND || "/config/band/generate" };
      }
      ts.tools.band = band;
    }
    cfg.channels = { ...(cfg.channels || {}), teamspeak: ts };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  '
  chmod 0600 "$OPENCLAW_CONFIG_PATH"
fi

# Last look before we hand over. If the config is invalid here, the gateway is
# about to exit and supervisord is about to restart it forever; printing the
# actual complaint once is the difference between a diagnosable loop and a wall
# of identical stack traces.
openclaw config validate || echo "run-gateway: WARNING — config validate failed (see above)." >&2

# --- 4. the gateway ---
echo "run-gateway: openclaw gateway --bind $SEXTON_GATEWAY_BIND --port $SEXTON_GATEWAY_PORT (state: $OPENCLAW_STATE_DIR)"
exec openclaw gateway --bind "$SEXTON_GATEWAY_BIND" --port "$SEXTON_GATEWAY_PORT"
