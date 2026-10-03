#!/bin/sh
# PHA-3791: ts-summoner, in the same container as the bots it schedules. Its
# config is /config/summoner/config.json plus this container's wiring, merged
# by stack.mjs into /run/universal/summoner.json. SUMMONER_ENABLED=0 idles it
# (every core then just runs), which is what a test instance wants.
set -eu
if [ "${SUMMONER_ENABLED:-1}" != "1" ]; then
  echo "run-summoner: disabled by SUMMONER_ENABLED=${SUMMONER_ENABLED:-}"
  exec sleep infinity
fi
if [ ! -s /config/summoner/query-pass.txt ]; then
  echo "run-summoner: no /config/summoner/query-pass.txt (the serveradmin query password); idling" >&2
  exec sleep infinity
fi
cd /opt/ts-summoner
SUMMONER_CONFIG=/run/universal/summoner.json exec node summoner.mjs
