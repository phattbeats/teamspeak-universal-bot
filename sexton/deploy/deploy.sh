#!/bin/bash
# PHA-3173 / PHA-3215 production deploy for the Sexton on PHATT-RAID.
# PHATT-RAID has no docker compose plugin, so this is the `docker run` form of
# sexton-compose.yml. Keep the two in step.
# Connect by container name on the TS6 server's own Docker network; do NOT use
# network_mode host + teamspeak.phatt.vip (hairpins, gets flood-scored --
# PHA-3099 finding #5).
#
# Lives on the box at /mnt/user/appdata/sexton/deploy.sh.
set -eu
IMG=${IMG:-phattbeats/sexton:latest}
docker rm -f sexton >/dev/null 2>&1 || true
mkdir -p /mnt/user/appdata/sexton/logs
# The healthcheck reads PID 1's argv: the runtime image is debian-slim and has
# no `pgrep`, so the old `pgrep -f` check exited 127 forever and the container
# was permanently unhealthy (PHA-3217). `-a` because /proc/1/cmdline is
# NUL-separated.
docker run -d --name sexton --network phattvip --restart unless-stopped \
  -e RUST_LOG=info \
  -v /mnt/user/appdata/sexton/logs:/var/sexton-logs \
  --health-cmd "grep -qa /usr/local/bin/sexton /proc/1/cmdline" --health-interval 30s \
  --health-timeout 5s --health-retries 3 \
  "$IMG" \
  -a teamspeak6-server -p 9987 \
  -n Sexton \
  -c "General Shit" \
  -i "$(cat /mnt/user/scratch/sexton/sexton-id.txt)" \
  -A /usr/local/share/sexton-avatar/brandon.png \
  -l /var/sexton-logs
