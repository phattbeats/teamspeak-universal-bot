#!/usr/bin/env bash
# #3791: (re)create the ONE container that runs every TeamSpeak bot.
#
#   TAG=<git sha> image/deploy.sh          # after image/build.sh
#
# This is the only deploy script. The per-bot wrappers (deploy-bexton.sh,
# deploy-lexton.sh, deploy-guest.sh) and the sidecars' own deploys (whisper,
# ts-summoner, suno-api) are gone: those services are programs inside this
# container now, and a bot is a persona pack + a line in /config/bots.json.
#
# What lives where on the host (APPDATA, default /mnt/user/appdata/teamspeak-universal-bot):
#   config/bots.json            which bots run, their bridge ports, identity sharing
#   config/bots/<id>/           TeamSpeak identity (sexton-id.txt), announce/off-duty files
#   config/openclaw/            the one gateway: openclaw.json, agents, workspaces
#   config/summoner/            shifts/scenes/guests config.json, live/, state/, query-pass.txt
#   config/suno-api.env         Suno cookie + 2Captcha key + proxy (0600)
#   config/insights/            the insights db + auth.txt, the dashboard login (#3963)
#   config/personas/<id>/       optional: add or override a persona pack without a rebuild
#   logs/<id>/                  each bot's room log
#
# First deploy on an empty APPDATA imports model credentials from the main
# OpenClaw gateway (models/auth/agents/tts/env/tools only, never its channels).
# Moving the old per-bot containers over is image/universal/migrate.mjs, once.
#
# PHATT-RAID has docker but no compose plugin, hence plain `docker run`.
set -euo pipefail

IMAGE=${IMAGE:-phattbeats/teamspeak-universal-bot}
TAG=${TAG:-latest}
NAME=${NAME:-teamspeak-universal-bot}
NETWORK=${NETWORK:-phattvip}
APPDATA=${APPDATA:-/mnt/user/appdata/teamspeak-universal-bot}
MAIN_GATEWAY=${MAIN_GATEWAY:-OpenClaw}
MAIN_CONFIG_PATH=${MAIN_CONFIG_PATH:-/root/.openclaw/openclaw.json}
# Extra `docker run` args, e.g. EXTRA_ARGS="-e SUMMONER_ENABLED=0" for a test instance.
EXTRA_ARGS=${EXTRA_ARGS:-}
# Host port for the insights dashboard (#3963); empty publishes nothing.
INSIGHTS_PUBLISH=${INSIGHTS_PUBLISH-8097}

log() { printf '\n== %s\n' "$*"; }

docker image inspect "$IMAGE:$TAG" >/dev/null || { echo "no image $IMAGE:$TAG; run image/build.sh first" >&2; exit 1; }
mkdir -p "$APPDATA/config/openclaw" "$APPDATA/logs"

gw_config="$APPDATA/config/openclaw/openclaw.json"
if [ ! -s "$gw_config" ] && [ ! -s "$APPDATA/config/openclaw/credentials.import.json" ]; then
  if docker ps --format '{{.Names}}' | grep -qx "$MAIN_GATEWAY"; then
    log "first deploy: importing model credentials from $MAIN_GATEWAY"
    # run-gateway merges this after seeding and deletes it.
    docker exec "$MAIN_GATEWAY" node -e '
      const src = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const out = {};
      for (const k of ["models", "auth", "agents", "tts", "env", "tools"]) if (src[k] !== undefined) out[k] = src[k];
      process.stdout.write(JSON.stringify(out, null, 2));
    ' "$MAIN_CONFIG_PATH" > "$APPDATA/config/openclaw/credentials.import.json.part"
    mv "$APPDATA/config/openclaw/credentials.import.json.part" "$APPDATA/config/openclaw/credentials.import.json"
    chmod 0600 "$APPDATA/config/openclaw/credentials.import.json"
  else
    echo "WARNING: no $MAIN_GATEWAY container to import credentials from; the bots will join and not answer" >&2
  fi
fi

log "starting $NAME from $IMAGE:$TAG"
docker rm -f "$NAME" >/dev/null 2>&1 || true
# --shm-size: chromium (suno-api) falls over on Docker's 64 MB default.
publish=""
[ -n "$INSIGHTS_PUBLISH" ] && publish="-p $INSIGHTS_PUBLISH:8097"
# shellcheck disable=SC2086
docker run -d \
  --name "$NAME" \
  --network "$NETWORK" \
  --restart unless-stopped \
  --shm-size 1g \
  -v "$APPDATA/config:/config" \
  -v "$APPDATA/logs:/var/sexton-logs" \
  $publish \
  $EXTRA_ARGS \
  "$IMAGE:$TAG" >/dev/null

log "waiting for the gateway"
ok=0
for _ in $(seq 1 60); do
  sleep 5
  if docker exec "$NAME" /usr/local/bin/universal-healthcheck >/dev/null 2>&1; then ok=1; break; fi
done
docker exec "$NAME" node /opt/universal/stack.mjs list || true
docker exec "$NAME" /usr/local/bin/universal-healthcheck || true
if [ "$ok" != 1 ]; then
  echo "gateway did not come up in 5 minutes: docker logs $NAME" >&2
  exit 1
fi
docker exec "$NAME" openclaw channels status 2>/dev/null | grep -i teamspeak || true
log "up: $NAME ($IMAGE:$TAG)"
[ -n "$INSIGHTS_PUBLISH" ] && echo "insights: http://<host>:$INSIGHTS_PUBLISH  (login: $APPDATA/config/insights/auth.txt)"
