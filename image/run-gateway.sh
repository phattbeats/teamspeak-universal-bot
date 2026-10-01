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

# --- 1c. a persona of our own (PHA-3554: Bexton; PHA-3787: the Sexton itself) ---
#
# The sexton image is also the Bexton image: same binary, same bridge, same
# gateway, a different agent in the chair. SEXTON_AGENT_ID names the agent this
# container's teamspeak channel binds to, and SEXTON_PERSONA_DIR is a directory
# of workspace files (AGENTS.md, SOUL.md, IDENTITY.md, HUMAN.md) baked into the
# image for it. Both are first-boot seeds: the workspace is copied only if the
# agent has none yet, and the agent entry + binding are written only if absent,
# so an operator's later edits to either survive every restart.
#
# PHA-3787 finding: this block used to skip entirely for SEXTON_AGENT_ID=sexton
# (the default), on the theory that the Sexton's own agent entry always already
# existed from the imported main-gateway config. That left its *workspace* with
# nothing seeding it, so OpenClaw's own first-conversation prompts
# ("_Fill this in during your first conversation_") sat there unfilled forever
# — a bot with no human to have that first conversation with. That is the
# "stuck up, not human" voice Brandon flagged. The workspace seed below now
# runs unconditionally (default agent id "sexton" when unset); only the
# agents.entries/binding creation stays gated to a second persona, since the
# Sexton's own entry and binding already come from the imported config.
AGENT_ID_EFFECTIVE="${SEXTON_AGENT_ID:-sexton}"
PERSONA_DIR="${SEXTON_PERSONA_DIR:-/opt/sexton-persona/${AGENT_ID_EFFECTIVE}}"
# PHA-3791: voice.json/tools.json (the persona pack's declarative defaults for
# wake names/aliases, TTS voice, and channels.teamspeak.tools.*) live in a
# SIBLING directory, not inside PERSONA_DIR. They are read by step 3 below.
# Deliberately not in PERSONA_DIR: everything in there gets `cp -a`-ed into
# the agent workspace above, and these two files are config for this script,
# not agent workspace content the model should see in its own directory.
PERSONA_CONFIG_DIR="${SEXTON_PERSONA_CONFIG_DIR:-${PERSONA_DIR}.config}"
WS="${OPENCLAW_STATE_DIR}/workspace/agents/${AGENT_ID_EFFECTIVE}"
if [ ! -d "$WS" ] && [ -d "$PERSONA_DIR" ]; then
  echo "run-gateway: seeding the ${AGENT_ID_EFFECTIVE} workspace from ${PERSONA_DIR}"
  mkdir -p "$WS"
  cp -a "$PERSONA_DIR"/. "$WS"/
fi
# PHA-3824: entrance/exit line pools for ts-summoner starts/stops. Copied in
# only when missing, never over the top: lines.json is meant to be hand-edited
# on the live bot, and the plugin re-reads it on every announcement.
if [ -d "$WS" ] && [ ! -f "$WS/lines.json" ] && [ -f "${PERSONA_CONFIG_DIR}/lines.json" ]; then
  cp "${PERSONA_CONFIG_DIR}/lines.json" "$WS/lines.json"
fi
# PHA-3840: per-shift mood table, same seed-once rule as lines.json. The
# announcer rolls from it on each shift start and writes mood/AGENTS.md; seed a
# neutral one so the hook has a file before the first roll.
if [ -d "$WS" ] && [ ! -f "$WS/moods.json" ] && [ -f "${PERSONA_CONFIG_DIR}/moods.json" ]; then
  cp "${PERSONA_CONFIG_DIR}/moods.json" "$WS/moods.json"
fi
if [ -d "$WS" ] && [ ! -f "$WS/mood/AGENTS.md" ]; then
  mkdir -p "$WS/mood"
  printf '# How today is going\n\nNothing special about today. Just a regular shift.\n' > "$WS/mood/AGENTS.md"
fi
# HUMAN.md is shared infrastructure, not persona content an operator hand-edits
# per bot — always sync it from the image, even onto a workspace that already
# exists, so a HUMAN.md fix ships without every persona needing re-seeding.
#
# PHA-3829: OpenClaw only injects AGENTS.md-class files, so a workspace
# HUMAN.md never reached the prompt at all; the bots were told to "read" it
# and never did. It lands as shared-tone/AGENTS.md instead, which the bundled
# bootstrap-extra-files hook injects (configured below). A real file, not a
# symlink: the hook refuses symlinked paths.
if [ -d "$WS" ] && [ -f "${PERSONA_DIR}/HUMAN.md" ]; then
  mkdir -p "$WS/shared-tone"
  cp -f "${PERSONA_DIR}/HUMAN.md" "$WS/shared-tone/AGENTS.md"
  printf '# HUMAN.md\n\nMoved to shared-tone/AGENTS.md (PHA-3829). OpenClaw only injects AGENTS.md-type files, so this file never reached the prompt.\n' > "$WS/HUMAN.md"
  node -e '
    const fs = require("fs");
    const p = process.env.OPENCLAW_CONFIG_PATH;
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    cfg.hooks = cfg.hooks || {};
    cfg.hooks.internal = cfg.hooks.internal || {};
    const entries = (cfg.hooks.internal.entries = cfg.hooks.internal.entries || {});
    const hook = (entries["bootstrap-extra-files"] = entries["bootstrap-extra-files"] || {});
    const paths = Array.isArray(hook.paths) ? hook.paths : [];
    const want = ["shared-tone/AGENTS.md", "mood/AGENTS.md"]; // mood: PHA-3840
    if (cfg.hooks.internal.enabled !== true || hook.enabled !== true || !want.every((w) => paths.includes(w))) {
      cfg.hooks.internal.enabled = true;
      hook.enabled = true;
      hook.paths = [...paths, ...want.filter((w) => !paths.includes(w))];
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
      console.log("run-gateway: bootstrap-extra-files hook now injects " + hook.paths.join(", "));
    }
  '
fi
if [ -n "${SEXTON_AGENT_ID:-}" ] && [ "${SEXTON_AGENT_ID}" != "sexton" ]; then
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
    // PHA-3791: the persona pack (personas/<id>/voice.json, tools.json,
    // baked into the image at /opt/sexton-persona/<id>.config/) is the new
    // default source for the fields below. SEXTON_* env vars still win when
    // present -- image/deploy.sh keeps setting them for a hand-tuned
    // redeploy -- this only changes what backs the default when they are
    // not set. Read defensively: an operator-supplied SEXTON_PERSONA_DIR
    // with no matching .config dir should not crash the boot.
    const personaConfigDir = process.argv[1];
    const readJson = (name) => {
      try {
        return JSON.parse(fs.readFileSync(`${personaConfigDir}/${name}`, "utf8"));
      } catch (e) {
        return {};
      }
    };
    const personaVoice = readJson("voice.json");
    const personaTools = readJson("tools.json");
    ts.channel = env.SEXTON_CHANNEL || ts.channel;
    ts.bridgeUrl = `ws://127.0.0.1:${(env.SEXTON_WS_BIND || "0.0.0.0:9099").split(":").pop()}`;
    // PHA-3598: SEXTON_WHISPER_URL points at the shared `whisper` pool
    // container (one worker port per bot); unset means the in-container
    // server. First boot only, like everything in this block — on a live bot
    // edit channels.teamspeak.voice.streaming.transcription.url in the mounted
    // openclaw.json by hand (with the gateway STOPPED) and restart the gateway.
    ts.voice.streaming.transcription.url =
      env.SEXTON_WHISPER_URL || `http://127.0.0.1:${env.WHISPER_PORT || 8080}/inference`;
    ts.tools.music.extraYtdlpArgs = [
      "--extractor-args",
      `youtubepot-bgutilhttp:base_url=http://127.0.0.1:${env.POT_PORT || 4416}`,
    ];
    if (typeof personaTools.music?.enabled === "boolean") {
      ts.tools.music.enabled = personaTools.music.enabled;
    }
    // Wake names follow the persona. Comma-separated; case variants are added
    // because the wake gate matches the transcript literally. Falls back to
    // the persona packs voice.json when no env override is set; falls back
    // further to the seeds own default (the Sextons names) if neither is set.
    if (env.SEXTON_WAKE_NAMES) {
      const names = env.SEXTON_WAKE_NAMES.split(",").map((n) => n.trim()).filter(Boolean);
      ts.voice.wakeNames = [...new Set(names.flatMap((n) => [n, n.toLowerCase()]))];
    } else if (Array.isArray(personaVoice.wakeNames) && personaVoice.wakeNames.length) {
      ts.voice.wakeNames = [...new Set(personaVoice.wakeNames.flatMap((n) => [n, n.toLowerCase()]))];
    }
    // PHA-3605: heard-aliases (exact whisper spellings of the name) and the
    // other bot in the room. The env var, when present, is always written,
    // even when empty: Bexton imports the Sexton config and must not
    // inherit the Sexton aliases. When the env var is not present at all,
    // the persona packs voice.json is the default (an empty list there
    // means the same "no aliases" the env-var path also supports).
    const csv = (v) => (v || "").split(",").map((n) => n.trim()).filter(Boolean);
    ts.voice.wakeAliases =
      env.SEXTON_WAKE_ALIASES !== undefined ? csv(env.SEXTON_WAKE_ALIASES) : (personaVoice.wakeAliases || []);
    ts.voice.excludeWakeNames =
      env.SEXTON_EXCLUDE_WAKE_NAMES !== undefined
        ? csv(env.SEXTON_EXCLUDE_WAKE_NAMES)
        : (personaVoice.excludeWakeNames || []);
    // A voice of its own (PHA-3554, Brandon: a different MiniMax voice so
    // Bexton does not match the Sexton). The plugin passes this as the TTS
    // override, so it wins over the voiceId in the imported tts block. The
    // persona packs voiceId is null for a persona that keeps the imported
    // voice (the Sexton today), same meaning as the env var being unset.
    if (env.SEXTON_TTS_VOICE_ID) {
      ts.voice.streaming.speech.voiceId = env.SEXTON_TTS_VOICE_ID;
    } else if (personaVoice.voiceId) {
      ts.voice.streaming.speech.voiceId = personaVoice.voiceId;
    }
    // Moderation (PHA-3793/PHA-3786 catalog, never codified before this
    // change): the persona packs tools.json is the only source for this --
    // there is no SEXTON_MODERATION_* env knob. Fails closed by default
    // (kick/ban/edit false, allowGroups empty) when the persona pack does
    // not say otherwise. This is a fresh-deploy default only; it does not
    // touch a config that already has a teamspeak block (the guard around
    // this whole step), so it cannot overwrite the live hand-applied
    // moderation grants on the running sexton/bexton containers.
    ts.tools.moderation = personaTools.moderation || { kick: false, ban: false, edit: false, allowGroups: [] };
    // The house band (PHA-3554). Opt-in, and the MiniMax key is the one the
    // TTS block already carries, so nobody types it twice. SEXTON_BAND_ENABLED
    // explicitly "1" or "0" wins; otherwise the persona packs tools.json
    // band.enabled decides (false/absent for the Sexton, true for Bexton).
    const personaBand = personaTools.band || {};
    const bandEnvSet = env.SEXTON_BAND_ENABLED === "1" || env.SEXTON_BAND_ENABLED === "0";
    const bandEnabled = bandEnvSet ? env.SEXTON_BAND_ENABLED === "1" : !!personaBand.enabled;
    if (bandEnabled) {
      const provider = env.SEXTON_BAND_PROVIDER || personaBand.provider || "minimax";
      const name = env.SEXTON_BAND_NAME || personaBand.name;
      const band = {
        enabled: true,
        provider,
        songsDir: "/config/band-songs",
        ...(name ? { name } : {}),
        // Pipe-separated (the names have commas in them). Unset keeps the
        // built-in billing; an explicit empty string means none. NO
        // apostrophes anywhere in this node script: it is a single-quoted
        // sh string and one apostrophe ends it (that is exactly what broke
        // the first pha-3554 boot).
        ...(env.SEXTON_BAND_ALIASES !== undefined
          ? { aliases: env.SEXTON_BAND_ALIASES.split("|").map((n) => n.trim()).filter(Boolean) }
          : personaBand.aliases
          ? { aliases: personaBand.aliases }
          : {}),
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
        const baseUrl = env.SEXTON_BAND_SUNO_API_URL || personaBand.sunoApi?.baseUrl;
        band.sunoApi = {
          ...(baseUrl ? { baseUrl } : {}),
          ...(env.SEXTON_BAND_SUNO_API_KEY ? { apiKey: env.SEXTON_BAND_SUNO_API_KEY } : {}),
        };
      } else if (provider === "command") {
        band.command = { path: env.SEXTON_BAND_COMMAND || "/config/band/generate" };
      }
      ts.tools.band = band;
    }
    cfg.channels = { ...(cfg.channels || {}), teamspeak: ts };
    // PHA-3792: the voice lane streams the reply into TTS per block. The
    // plugin forces block streaming on per voice turn and carries its own
    // sentence-sized chunking on a per-turn config copy, so these defaults
    // are the fallback for a host that ignores the copy (a prepared reply
    // runtime in scope) -- not the switch. Only written when unset, so an
    // operator who tuned them keeps their numbers.
    cfg.agents = cfg.agents || {};
    cfg.agents.defaults = cfg.agents.defaults || {};
    if (!cfg.agents.defaults.blockStreamingChunk) {
      cfg.agents.defaults.blockStreamingChunk = { minChars: 24, maxChars: 400, breakPreference: "sentence" };
    }
    if (!cfg.agents.defaults.blockStreamingCoalesce) {
      cfg.agents.defaults.blockStreamingCoalesce = { minChars: 24, maxChars: 400, idleMs: 0 };
    }
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  ' "$PERSONA_CONFIG_DIR"
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
