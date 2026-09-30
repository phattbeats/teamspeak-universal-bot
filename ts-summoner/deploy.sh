#!/bin/sh
# PHA-3821 ts-summoner: build + (re)create. Run on PHATT-RAID from /mnt/user/appdata/ts-summoner.
set -eu
cd /mnt/user/appdata/ts-summoner
docker build -t ts-summoner:local .
docker rm -f ts-summoner 2>/dev/null || true
docker run -d --name ts-summoner --restart unless-stopped --network phattvip \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /mnt/user/appdata/ts-summoner/config.json:/app/config.json:ro \
  -v /mnt/user/appdata/ts-summoner/query-pass.txt:/app/query-pass.txt:ro \
  ts-summoner:local
