#!/bin/bash
# PHA-3173 / PHA-3215 production deploy for the Sexton on PHATT-RAID.
# PHATT-RAID has no docker compose plugin, so this is the `docker run` form of
# sexton/deploy/sexton-compose.yml in github.com/phattbeats/plnt-sexton.
# Connect by container name on the TS6 server own Docker network; do NOT use
# network_mode host + teamspeak.phatt.vip (hairpins, gets flood-scored --
# PHA-3099 finding #5).
set -eu
IMG=${IMG:-phattbeats/sexton:latest}
docker rm -f sexton >/dev/null 2>&1 || true
mkdir -p /mnt/user/appdata/sexton/logs
docker run -d --name sexton --network phattvip --restart unless-stopped \
  -e RUST_LOG=info \
  -v /mnt/user/scratch/sexton/secrets/paperclip-bearer:/run/secrets/paperclip-bearer:ro \
  -v /mnt/user/appdata/sexton/logs:/var/sexton-logs \
  --health-cmd "pgrep -f /usr/local/bin/sexton" --health-interval 30s \
  --health-timeout 5s --health-retries 3 \
  "$IMG" \
  -a teamspeak6-server -p 9987 \
  -n Sexton \
  -c "General Shit" \
  -i "$(cat /mnt/user/scratch/sexton/sexton-id.txt)" \
  -A /usr/local/share/sexton-avatar/brandon.png \
  -l /var/sexton-logs \
  --on-connected /usr/local/bin/on-connected
