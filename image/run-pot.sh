#!/bin/sh
# #3428: the bgutil POT provider for the #3176 music lane.
#
# Optional on purpose. YouTube only intermittently challenges datacenter IPs,
# and yt-dlp degrades to "challenged more often", not "broken", without a POT.
# So an image built with WITH_POT=0, or one whose POT build stage failed, must
# come up with music working and this lane quietly absent — never a restart
# loop, and never a container the healthcheck calls dead.
#
# Exiting 0 here is the contract with supervisord's `autorestart=unexpected`:
# clean exit means "not installed", so it stays down.
set -eu

: "${POT_PORT:=4416}"
# The provider defaults to 127.0.0.1 (and tries [::1], which this container has
# no address for — hence the "EADDRNOTAVAIL ::1:4416" line in the first build's
# log). Loopback is the wrong bind here: the yt-dlp that consumes the token runs
# in the OpenClaw gateway, in a different container, and reaches this by name on
# `phattvip`. Same reasoning as whisper's bind, and safe for the same reason —
# the port is never published to the host.
: "${POT_HOST:=0.0.0.0}"

if [ -f /opt/bgutil-pot/DISABLED ]; then
  echo "run-pot: POT provider not installed ($(cat /opt/bgutil-pot/DISABLED)); music runs without it."
  exit 0
fi
if [ ! -f /opt/bgutil-pot/build/main.js ]; then
  echo "run-pot: no build/main.js under /opt/bgutil-pot; music runs without a POT token."
  exit 0
fi

echo "run-pot: bgutil POT provider on ${POT_HOST}:${POT_PORT}"
cd /opt/bgutil-pot
exec /usr/local/bin/node build/main.js --port "$POT_PORT" --host "$POT_HOST"
