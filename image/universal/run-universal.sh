#!/bin/sh
# #3791: the one container's entrypoint. Derive the per-bot supervisor
# programs and the summoner's config from /config/bots.json and the persona
# packs, then hand PID 1 to supervisord. A broken bots.json stops here, loudly,
# rather than starting a stack with no bots in it.
set -eu
node /opt/universal/stack.mjs supervisor
exec /usr/bin/supervisord -c /etc/supervisor/universal.conf
