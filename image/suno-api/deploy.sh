#!/usr/bin/env bash
# PHA-3554: the house band's generator — a self-hosted gcui-art/suno-api on
# PHATT-RAID, beside the TS6 server on `phattvip`.
#
# Brandon's pick, 2026-09-18, after MiniMax closed its Music API to the
# account: "Self-host suno-api on phattvip with my Suno cookie".
#
# What it is: a Next.js service that drives a Suno web account the way the
# browser does. It needs TWO secrets and one browser:
#   SUNO_COOKIE     the Cookie header from a logged-in suno.com session
#                   (README: suno.com/create -> F12 -> Network -> the request
#                   with ?__clerk_api_version -> copy the Cookie value)
#   TWOCAPTCHA_KEY  a 2captcha.com key. Suno puts an hCaptcha in front of every
#                   generation and suno-api pays 2Captcha to solve it (about
#                   $1-3 per 1000 solves; one solve per song). Not optional.
#   chromium        baked into the image (Playwright), headless, GPU off.
#
# Both secrets live in ONE file on the box, mode 0600, never in this repo and
# never on a `docker run` command line where `docker inspect` would show them:
#   /mnt/user/appdata/suno-api/.env
# with the .env.example keys (SUNO_COOKIE=, TWOCAPTCHA_KEY=, BROWSER=chromium,
# BROWSER_HEADLESS=true, BROWSER_LOCALE=en, BROWSER_GHOST_CURSOR=false).
#
# Nothing is published to the host. Bexton reaches it as http://suno-api:3000
# over `phattvip`, which is the only client it has.
#
# Build first (the image is ~2 GB with chromium):
#   cd /mnt/user/appdata/suno-api && git clone https://github.com/gcui-art/suno-api.git src
#   docker build -t phattbeats/suno-api:latest src
set -euo pipefail

IMAGE=${IMAGE:-phattbeats/suno-api:latest}
NAME=${NAME:-suno-api}
NETWORK=${NETWORK:-phattvip}
APPDATA=${APPDATA:-/mnt/user/appdata/suno-api}
ENV_FILE=${ENV_FILE:-$APPDATA/.env}

log() { printf '\n== %s\n' "$*"; }

[ -s "$ENV_FILE" ] || {
  echo "no $ENV_FILE. Create it (mode 0600) with SUNO_COOKIE= and TWOCAPTCHA_KEY= from" >&2
  echo "https://github.com/gcui-art/suno-api#readme, then re-run." >&2
  exit 1
}
grep -q '^SUNO_COOKIE=.\{20,\}' "$ENV_FILE" || { echo "SUNO_COOKIE is empty in $ENV_FILE" >&2; exit 1; }
grep -q '^TWOCAPTCHA_KEY=.\{10,\}' "$ENV_FILE" || { echo "TWOCAPTCHA_KEY is empty in $ENV_FILE" >&2; exit 1; }
chmod 0600 "$ENV_FILE"
# Defaults the .env.example carries; harmless if already present.
grep -q '^BROWSER=' "$ENV_FILE" || printf 'BROWSER=chromium\nBROWSER_HEADLESS=true\nBROWSER_LOCALE=en\nBROWSER_GHOST_CURSOR=false\n' >> "$ENV_FILE"

log "restarting $NAME from $IMAGE"
docker rm -f "$NAME" >/dev/null 2>&1 || true
# --shm-size: chromium under Playwright falls over on Docker's 64 MB default.
docker run -d \
  --name "$NAME" \
  --network "$NETWORK" \
  --restart unless-stopped \
  --shm-size 1g \
  --env-file "$ENV_FILE" \
  -e BROWSER_DISABLE_GPU=true \
  -v "$APPDATA/public":/app/public \
  "$IMAGE"

log "waiting for the API"
for _ in $(seq 1 30); do
  if docker exec "$NAME" node -e 'fetch("http://127.0.0.1:3000/api/get_limit").then(r=>r.text()).then(t=>{console.log(t.slice(0,300));process.exit(0)}).catch(()=>process.exit(1))' 2>/dev/null; then
    break
  fi
  sleep 5
done

cat <<EOF

== next ==
The quota line above is the proof the cookie works: "credits_left" means Suno
accepted the session. A login error means the cookie is stale — copy a fresh one.

Point Bexton at it (already the default in image/deploy-bexton.sh):
  BAND_PROVIDER=suno-api  BAND_SUNO_API_URL=http://${NAME}:3000
or on a running bexton, set channels.teamspeak.tools.band.provider = "suno-api"
and .sunoApi.baseUrl = "http://${NAME}:3000" in /config/openclaw/openclaw.json
and: docker exec bexton supervisorctl -c /etc/supervisor/conf.d/sexton.conf restart gateway
EOF
