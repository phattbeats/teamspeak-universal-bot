#!/bin/sh
# PHA-3554/3791: the self-hosted suno-api (gcui-art/suno-api + our patches,
# image/suno-api/patches/) for Bexton's band, on loopback :3000. Its secrets
# (SUNO_COOKIE, TWOCAPTCHA_KEY, proxy) live in /config/suno-api.env, mode 0600,
# never in the image or on a docker command line. No file: idle, the band
# reports itself unavailable.
set -eu
ENV_FILE=${SUNO_ENV_FILE:-/config/suno-api.env}
if [ ! -s "$ENV_FILE" ] || [ ! -d /opt/suno-api/.next ]; then
  echo "run-suno-api: no $ENV_FILE (or no build); suno-api is off"
  exec sleep infinity
fi
export BROWSER_DISABLE_GPU=true PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# public/ is a symlink to the volume (Dockerfile): whatever lands there survives.
mkdir -p /config/suno-api/public
cd /opt/suno-api
# The env file is read literally (env-exec.mjs): the cookie is full of ; and $.
exec node /opt/universal/env-exec.mjs "$ENV_FILE" \
  node node_modules/next/dist/bin/next start -H 127.0.0.1 -p "${SUNO_API_PORT:-3000}"
