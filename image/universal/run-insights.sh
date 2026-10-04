#!/bin/sh
# PHA-3963: the insights dashboard (who's on, when, what they said, what the
# bots got out of them). The summoner records into /config/insights/insights.db;
# this serves it on :8097 behind basic auth (/config/insights/auth.txt) and pulls
# the gateway's transcripts in. INSIGHTS_ENABLED=0 idles it.
set -eu
if [ "${INSIGHTS_ENABLED:-1}" != "1" ]; then
  echo "run-insights: disabled by INSIGHTS_ENABLED=${INSIGHTS_ENABLED:-}"
  exec sleep infinity
fi
# stack.mjs writes the merged summoner config at boot; it names the bots and the db.
for _ in $(seq 1 60); do
  [ -s /run/universal/summoner.json ] && break
  sleep 2
done
cd /opt/ts-summoner
SUMMONER_CONFIG=/run/universal/summoner.json exec node insights-web.mjs
