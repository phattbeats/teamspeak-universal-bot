#!/bin/sh
# PHA-3821 ts-summoner: build + (re)create. Run on PHATT-RAID from /mnt/user/appdata/ts-summoner.
# PHA-3841: live/ (calendar.json, scenes.json) is mounted as a DIRECTORY and
# re-read on change. Not single-file mounts: editors and `sed -i` replace the
# file, and a single-file bind mount keeps showing the old inode.
# state/ holds the rare-event state (takeover/bender) across restarts.
set -eu
cd /mnt/user/appdata/ts-summoner
mkdir -p state live
docker build -t ts-summoner:local .
docker rm -f ts-summoner 2>/dev/null || true
docker run -d --name ts-summoner --restart unless-stopped --network phattvip \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /mnt/user/appdata/sexton/logs:/var/sexton-logs \
  -v /mnt/user/appdata/ts-summoner/config.json:/app/config.json:ro \
  -v /mnt/user/appdata/ts-summoner/query-pass.txt:/app/query-pass.txt:ro \
  -v /mnt/user/appdata/ts-summoner/live:/app/live:ro \
  -v /mnt/user/appdata/ts-summoner/state:/app/state \
  ts-summoner:local
