#!/usr/bin/env bash
# PHA-3428: deploy the one-container Sexton on PHATT-RAID.
#
# This replaces THREE deploys that used to be separate:
#   sexton/deploy/deploy.sh   (the bot)
#   ts-bridge's docker run    (gone since PHA-3342, folded into the bot)
#   whisper/deploy.sh         (the STT sidecar; its model is baked in now)
# Those are superseded. Do not run them alongside this — two bots on one
# identity is a UID collision and the server drops one of them.
#
# Unraid has no compose plugin, so this is the `docker run` form of the Unraid
# template in image/unraid-sexton.xml. Keep the two in step.
#
# Network: the TS6 server's own Docker network (`phattvip`), by container name.
# NOT network_mode host + teamspeak.phatt.vip — the RAID and the server share
# one public IP, so that route hairpins and gets flood-scored (PHA-3099
# finding #5).
#
# Lives on the box at /mnt/user/appdata/sexton/deploy.sh.
set -euo pipefail

IMAGE=${IMAGE:-phattbeats/sexton:latest}
NAME=${NAME:-sexton}
NETWORK=${NETWORK:-phattvip}
APPDATA=${APPDATA:-/mnt/user/appdata/sexton}
CHANNEL=${CHANNEL:-General Shit}
NICK=${NICK:-Sexton}
TS_HOST=${TS_HOST:-teamspeak6-server}
TS_PORT=${TS_PORT:-9987}
WHISPER_THREADS=${WHISPER_THREADS:-4}
# PHA-3598: STT comes from the shared `whisper` pool container (whisper/deploy.sh).
# The in-container whisper-server is left down (WHISPER_ENABLED=0) so each bot
# stops paying ~250 MB and 2-3 cores for a decoder the other bot is duplicating.
# Set WHISPER_ENABLED=1 and SEXTON_WHISPER_URL= (empty) to go back to in-container.
# PHA-3607: both bots point at the pool's coalescing proxy (:8082), not at a
# worker port directly -- it fans one decode out to both bots when their
# segmenters close on the same utterance, instead of each bot decoding it
# separately. Both are first-boot-only for the URL: on an existing appdata the
# mounted openclaw.json already carries the URL and is what wins (see
# run-gateway.sh) -- a redeploy of an *existing* bot needs that key patched by
# hand, same trap as PHA-3605's wake env.
WHISPER_ENABLED=${WHISPER_ENABLED:-0}
SEXTON_WHISPER_URL=${SEXTON_WHISPER_URL-http://whisper:8082/inference}
# PHA-3428 option (a): this container runs its OWN gateway. MAIN_GATEWAY is the
# other one — we read model credentials out of it once, and we disable its
# teamspeak channel at cutover, because two gateways on one bridge socket is
# two answers to every message in the room.
MAIN_GATEWAY=${MAIN_GATEWAY:-OpenClaw}
GATEWAY_PORT=${GATEWAY_PORT:-18789}
# Set to 0 for the documented rollback to (b): no in-container gateway, and you
# re-point the main one at ws://sexton:9099 yourself.
GATEWAY_ENABLED=${GATEWAY_ENABLED:-1}
# Set to 0 to leave the main gateway's teamspeak channel alone. Only sensible
# when GATEWAY_ENABLED=0; otherwise you get the double-answer.
DISABLE_MAIN_TEAMSPEAK=${DISABLE_MAIN_TEAMSPEAK:-1}
# Copy models/auth/agents/tts from the main gateway into this one on first
# deploy. Skipped automatically once the in-container config exists.
IMPORT_GATEWAY_CONFIG=${IMPORT_GATEWAY_CONFIG:-1}
# Where to import them FROM. The main gateway by default; a second persona
# (PHA-3554, image/deploy-bexton.sh) imports from the running sexton container
# instead, because that config already has the workspace paths, the sonnet
# model and the TTS voice that are known to work on this lane.
IMPORT_FROM=${IMPORT_FROM:-$MAIN_GATEWAY}
IMPORT_CONFIG_PATH=${IMPORT_CONFIG_PATH:-/root/.openclaw/openclaw.json}
# PHA-3554: a persona other than the Sexton in this container. Empty = the
# Sexton. See image/deploy-bexton.sh for the values.
AGENT_ID=${AGENT_ID:-}
WAKE_NAMES=${WAKE_NAMES:-}
# PHA-3605: exact whisper hearings accepted as the name, and the other bot's
# names that must NOT wake this one. Defaults are the Sexton's; a second
# persona sets both (empty is a valid value: WAKE_ALIASES= to have none).
WAKE_ALIASES=${WAKE_ALIASES-section,sections,sex and,sexin,saxton,sex ton,sex done}
EXCLUDE_WAKE_NAMES=${EXCLUDE_WAKE_NAMES-Bexton,band leader,maestro}
# MiniMax voice id for this persona; empty keeps the imported tts block's.
TTS_VOICE_ID=${TTS_VOICE_ID:-}
BAND_ENABLED=${BAND_ENABLED:-0}
BAND_PROVIDER=${BAND_PROVIDER:-minimax}
AVATAR=${AVATAR:-/usr/local/share/sexton-avatar/brandon.png}
# PHA-3573: suppress the catch-up recap for a second persona sharing the
# Sexton's channel (image/deploy-bexton.sh sets this) — the welcome PM still
# fires. Default off, so the Sexton itself is unaffected.
SEXTON_NO_CATCHUP=${SEXTON_NO_CATCHUP:-0}
# PHA-3818: drop the welcome PM too, for a persona that isn't the Sexton
# (image/deploy-lexton.sh sets this). Default off.
SEXTON_NO_WELCOME=${SEXTON_NO_WELCOME:-0}

log() { printf '\n== %s\n' "$*"; }

mkdir -p "$APPDATA/logs" "$APPDATA/config" "$APPDATA/config/openclaw"

# The identity is the bot's server-side UID and its permissions. It used to be
# read from /mnt/user/scratch/sexton/sexton-id.txt at deploy time and passed on
# the command line, where `docker inspect` shows it to anyone on the box. It
# now lives in the mounted config dir instead. Migrate the old one once.
# Only for the Sexton itself: a second persona must NOT inherit this identity,
# or two bots share one UID and the server drops one of them.
if [ "$NAME" = "sexton" ] && [ ! -s "$APPDATA/config/sexton-id.txt" ] && [ -s /mnt/user/scratch/sexton/sexton-id.txt ]; then
  log "migrating the bot identity into $APPDATA/config"
  install -m 0600 /mnt/user/scratch/sexton/sexton-id.txt "$APPDATA/config/sexton-id.txt"
fi
if [ ! -s "$APPDATA/config/sexton-id.txt" ]; then
  echo "WARNING: no identity at $APPDATA/config/sexton-id.txt." >&2
  echo "         The bot will generate one, print it once, and come up as a new" >&2
  echo "         unprivileged account. Copy it out of 'docker logs $NAME' into" >&2
  echo "         that file before the next restart." >&2
fi

log "stopping the old stack"
docker rm -f "$NAME" >/dev/null 2>&1 || true
# ts-bridge is a sidecar this image fully absorbed (PHA-3342) and is always
# safe to remove. `whisper` used to be in this list too, back when it was a
# leftover in-container sidecar this image superseded — but since PHA-3598 it
# is the shared whisper-server pool BOTH sexton and bexton call over the
# network (whisper/deploy.sh), so removing it here as "superseded" was a live
# STT outage waiting to happen on every redeploy. Do not add it back; redeploy
# it separately via whisper/deploy.sh if it ever actually needs replacing.
for old in ts-bridge; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$old"; then
    echo "removing superseded container: $old"
    docker rm -f "$old" >/dev/null 2>&1 || true
  fi
done

# --------------------------------------------------------------------------
# PHA-3428 option (a): give the in-container gateway its model credentials.
#
# This is the config burden option (b) existed to avoid, paid once, by machine,
# rather than by asking anyone to retype API keys into a second config. We copy
# only the blocks a channel-serving gateway actually needs; `channels`,
# `gateway` and `plugins` are deliberately NOT copied — this gateway's channel
# set, bind and plugin list are its own, and importing the main gateway's would
# start Discord/Signal/WhatsApp in here too.
#
# Runs only when the in-container config has no credentials yet, so a re-deploy
# never clobbers hand-edits.
# --------------------------------------------------------------------------
gw_config="$APPDATA/config/openclaw/openclaw.json"
if [ "$IMPORT_GATEWAY_CONFIG" = "1" ] && [ "$GATEWAY_ENABLED" = "1" ]; then
  if [ -s "$gw_config" ] && grep -q '"models"' "$gw_config"; then
    echo "gateway config already has a models block — not importing"
  elif ! docker ps --format '{{.Names}}' | grep -qx "$IMPORT_FROM"; then
    echo "WARNING: $IMPORT_FROM is not running; cannot import credentials." >&2
    echo "         The bot will join the channel and not answer until you" >&2
    echo "         put a models/auth block in $gw_config." >&2
  else
    log "importing models/auth/agents/tts from the $IMPORT_FROM gateway ($IMPORT_CONFIG_PATH)"
    mkdir -p "$APPDATA/config/openclaw"
    # We only DROP THE FILE here; run-gateway merges it on boot and deletes it.
    # Doing the merge there rather than here keeps this order-independent: the
    # seed has to be written first (it substitutes the channel name and the
    # loopback ports from the container's env, which this script cannot do),
    # and that only happens inside the container.
    #
    # Read through the main gateway's own node so we never have to care where
    # its config lives on the host. Written to a .part and moved on success —
    # a truncated import is the one thing that could leave the Sexton's gateway
    # with half a credentials block.
    docker exec "$IMPORT_FROM" node -e '
      const fs = require("fs");
      const src = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const out = {};
      // NOT channels/gateway/plugins: this gateway'"'"'s channel set, bind and
      // plugin list are its own. Importing the main gateway'"'"'s `channels`
      // would start Discord, Signal and WhatsApp in here too.
      for (const k of ["models", "auth", "agents", "tts", "env"]) {
        if (src[k] !== undefined) out[k] = src[k];
      }
      // Bindings, but ONLY the teamspeak one. `agents` above brings over every
      // agent the main gateway defines, and with more than one agent present
      // the channel refuses to start rather than guess: "Multiple agents are
      // configured, but teamspeak account default routing has no explicit
      // owner." The teamspeak binding is the answer to exactly that, and it
      // names the agent that has actually been serving the room.
      //
      // The discord/signal/whatsapp bindings are dropped: harmless here, since
      // those channels are not configured, but a binding for a channel this
      // gateway does not run is a lie in a config file.
      if (Array.isArray(src.bindings)) {
        const ts = src.bindings.filter((b) => b?.match?.channel === "teamspeak");
        if (ts.length) out.bindings = ts;
      }
      process.stdout.write(JSON.stringify(out, null, 2));
    ' "$IMPORT_CONFIG_PATH" > "$APPDATA/config/openclaw/credentials.import.json.part"
    mv "$APPDATA/config/openclaw/credentials.import.json.part" \
       "$APPDATA/config/openclaw/credentials.import.json"
    chmod 0600 "$APPDATA/config/openclaw/credentials.import.json"
    echo "staged $APPDATA/config/openclaw/credentials.import.json (run-gateway consumes it at boot)"
  fi
fi

log "starting $NAME from $IMAGE"
docker run -d \
  --name "$NAME" \
  --network "$NETWORK" \
  --restart unless-stopped \
  -e RUST_LOG=info \
  -e SEXTON_ADDR="$TS_HOST" \
  -e SEXTON_PORT="$TS_PORT" \
  -e SEXTON_NICK="$NICK" \
  -e SEXTON_CHANNEL="$CHANNEL" \
  -e SEXTON_LOG_DIR=/var/sexton-logs \
  -e SEXTON_IDENTITY_FILE=/config/sexton-id.txt \
  -e SEXTON_AVATAR="$AVATAR" \
  -e WHISPER_THREADS="$WHISPER_THREADS" \
  -e WHISPER_ENABLED="$WHISPER_ENABLED" \
  ${SEXTON_WHISPER_URL:+-e SEXTON_WHISPER_URL="$SEXTON_WHISPER_URL"} \
  -e SEXTON_GATEWAY_ENABLED="$GATEWAY_ENABLED" \
  -e SEXTON_GATEWAY_PORT="$GATEWAY_PORT" \
  -e SEXTON_AGENT_ID="$AGENT_ID" \
  -e SEXTON_WAKE_NAMES="$WAKE_NAMES" \
  -e SEXTON_WAKE_ALIASES="$WAKE_ALIASES" \
  -e SEXTON_EXCLUDE_WAKE_NAMES="$EXCLUDE_WAKE_NAMES" \
  -e SEXTON_NO_CATCHUP="$SEXTON_NO_CATCHUP" \
  -e SEXTON_NO_WELCOME="$SEXTON_NO_WELCOME" \
  ${TTS_VOICE_ID:+-e SEXTON_TTS_VOICE_ID="$TTS_VOICE_ID"} \
  -e SEXTON_BAND_ENABLED="$BAND_ENABLED" \
  -e SEXTON_BAND_PROVIDER="$BAND_PROVIDER" \
  ${BAND_NAME:+-e SEXTON_BAND_NAME="$BAND_NAME"} \
  ${BAND_ALIASES+-e SEXTON_BAND_ALIASES="$BAND_ALIASES"} \
  ${BAND_SUNO_API_URL:+-e SEXTON_BAND_SUNO_API_URL="$BAND_SUNO_API_URL"} \
  ${BAND_SUNO_API_KEY:+-e SEXTON_BAND_SUNO_API_KEY="$BAND_SUNO_API_KEY"} \
  ${BAND_COMMAND:+-e SEXTON_BAND_COMMAND="$BAND_COMMAND"} \
  -v "$APPDATA/logs":/var/sexton-logs \
  -v "$APPDATA/config":/config \
  "$IMAGE"

log "waiting for health"
for _ in $(seq 1 40); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo unknown)
  [ "$status" = "healthy" ] && break
  [ "$status" = "unhealthy" ] && break
  sleep 5
done
docker inspect -f "$NAME: {{.State.Status}} health={{.State.Health.Status}}" "$NAME"

# --------------------------------------------------------------------------
# Turn the main gateway's teamspeak channel off — AFTER the new one is up.
#
# This is the other half of "do not wire the bridge socket out to the main
# gateway" (Brandon, 2026-09-12), and it is not optional housekeeping: until it
# runs, the main gateway is still dialling ws://sexton:9099 and the room gets
# every answer twice, from two different agents.
#
# Order matters, and the wrong order is the one that bites. Disabling before
# the new gateway answers leaves the channel with NO agent in it for however
# long this deploy takes to go wrong — a silent Sexton, which from the room
# looks exactly like the bot being broken. So: wait for health first, confirm
# this container's gateway has actually connected the channel, and only then
# take the old one out.
#
# If the new gateway did NOT connect, we leave the main one alone and say so.
# Double answers are annoying; no answers is an outage.
# --------------------------------------------------------------------------
if [ "$DISABLE_MAIN_TEAMSPEAK" = "1" ] && [ "$GATEWAY_ENABLED" = "1" ]; then
  log "waiting for this container's gateway to connect the teamspeak channel"
  connected=0
  for _ in $(seq 1 30); do
    if docker exec "$NAME" openclaw channels status 2>/dev/null \
         | grep -i teamspeak | grep -q connected; then
      connected=1
      break
    fi
    sleep 5
  done
  docker exec "$NAME" openclaw channels status 2>&1 | grep -i teamspeak || true

  if [ "$connected" = 1 ]; then
    if docker ps --format '{{.Names}}' | grep -qx "$MAIN_GATEWAY"; then
      log "disabling the teamspeak channel on the $MAIN_GATEWAY gateway"
      # Config edit + restart, NOT `openclaw channels …`. There is no
      # `channels disable` subcommand, and `channels remove --channel` takes a
      # fixed enum of built-in channel names that a PLUGIN channel like
      # teamspeak is not in — so neither CLI path can turn this one off.
      #
      # And the way to turn it off is to DELETE the block, not to set
      # `enabled: false` on it. The plugin declares its channel schema with
      # additionalProperties: false, so an `enabled` key makes the whole config
      # invalid — "must not have additional properties" — and that gateway then
      # refuses to start at all, taking Discord, Signal and WhatsApp down with
      # it. That is a worse outage than the one this step exists to prevent,
      # and it is exactly what happened the first time. The block is saved
      # beside the config first, so the (b) rollback is a copy-back.
      docker exec "$MAIN_GATEWAY" node -e '
        const fs = require("fs");
        const p = "/root/.openclaw/openclaw.json";
        const c = JSON.parse(fs.readFileSync(p, "utf8"));
        if (!c.channels || !c.channels.teamspeak) {
          console.log("no teamspeak channel block; nothing to disable");
          process.exit(0);
        }
        fs.writeFileSync(
          "/root/.openclaw/openclaw.json.teamspeak-block.bak",
          JSON.stringify(c.channels.teamspeak, null, 2) + "\n"
        );
        delete c.channels.teamspeak;
        fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
        console.log("removed channels.teamspeak (saved to openclaw.json.teamspeak-block.bak); remaining: " + Object.keys(c.channels).join(", "));
      ' || { echo "WARNING: could not edit $MAIN_GATEWAY config — remove its channels.teamspeak block by hand, or the room hears everything twice." >&2; }

      log "restarting $MAIN_GATEWAY so the change takes"
      # This briefly drops Discord/Signal/WhatsApp on that gateway. The Sexton
      # is unaffected — its channel is served from this container now, which is
      # the entire point of option (a).
      docker restart "$MAIN_GATEWAY" >/dev/null \
        || echo "WARNING: could not restart $MAIN_GATEWAY; it is still serving teamspeak until you do." >&2
    else
      echo "note: $MAIN_GATEWAY is not running; nothing to disable."
    fi
  else
    echo >&2
    echo "WARNING: this container's gateway did not report the teamspeak channel" >&2
    echo "         connected. LEAVING the main gateway's channel enabled, so the" >&2
    echo "         room still has an agent in it." >&2
    echo "         Expect double answers until one of them is turned off." >&2
    echo "         Look at:  docker logs $NAME 2>&1 | grep -i run-gateway" >&2
    echo "         Most likely cause: no model credentials in" >&2
    echo "         $APPDATA/config/openclaw/openclaw.json." >&2
  fi
fi

cat <<EOF

== the gateway side ==
Option (a), per Brandon 2026-09-12: the teamspeak plugin runs in THIS
container's own OpenClaw gateway. There is nothing to configure on the main
gateway and nothing to bind-mount into it — the /opt/sexton-tools export and
the two read-only Unraid path mappings option (b) needed are gone, along with
the GUI steps they required.

Everything is already wired, on loopback:
  plugin -> bridge        ws://127.0.0.1:9099
  plugin -> whisper       http://127.0.0.1:8080/inference
  plugin -> POT provider  http://127.0.0.1:4416
  plugin -> yt-dlp/ffmpeg /usr/local/bin/yt-dlp, /usr/bin/ffmpeg  (in here, pinned)

Config lives at ${APPDATA}/config/openclaw/openclaw.json. Seeded on first boot;
yours to edit after that.

Check it:
  docker exec ${NAME} supervisorctl status
  docker exec ${NAME} openclaw channels status
  docker exec ${NAME} openclaw plugins list | head -5
  docker logs ${NAME} 2>&1 | grep -i run-gateway

If 'openclaw channels status' shows teamspeak configured-but-not-connected, the
usual cause is no model credentials — re-run this script with
IMPORT_GATEWAY_CONFIG=1, or put a models/auth block in that file by hand.

Rolling back to (b), if this ever needs it:
  GATEWAY_ENABLED=0 DISABLE_MAIN_TEAMSPEAK=0 image/deploy.sh
then copy the saved block back into the main gateway's config and restart it:
  docker exec ${MAIN_GATEWAY} node -e '
    const fs=require("fs"), p="/root/.openclaw/openclaw.json";
    const c=JSON.parse(fs.readFileSync(p,"utf8"));
    c.channels.teamspeak=JSON.parse(fs.readFileSync(p+".teamspeak-block.bak","utf8"));
    c.channels.teamspeak.bridgeUrl="ws://${NAME}:9099";
    fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");'
  docker restart ${MAIN_GATEWAY}
There is no CLI for this — see the note above the disable step. That also needs
the bridge/whisper ports reachable from ${MAIN_GATEWAY} on ${NETWORK}, which
they are — they bind 0.0.0.0 and both containers are on that network. Nothing
is published to the host either way.
EOF
