#!/usr/bin/env bash
# PHA-3428: deploy the one-container Sexton on PHATT-RAID.
#
# This replaces THREE deploys that used to be separate:
#   sexton/deploy/deploy.sh   (the bot)
#   ts-bridge's docker run    (gone since PHA-3342, folded into the bot)
#   whisper/deploy.sh         (the STT sidecar; its model is baked in now)
# Those are superseded. Do not run them alongside this — two bots on one
# identity is a UID collision and the server drops one of them.
#
# Unraid has no compose plugin, so this is the `docker run` form of the Unraid
# template in image/unraid-sexton.xml. Keep the two in step.
#
# Network: the TS6 server's own Docker network (`phattvip`), by container name.
# NOT network_mode host + teamspeak.phatt.vip — the RAID and the server share
# one public IP, so that route hairpins and gets flood-scored (PHA-3099
# finding #5).
#
# Lives on the box at /mnt/user/appdata/sexton/deploy.sh.
set -euo pipefail

IMAGE=${IMAGE:-phattbeats/sexton:latest}
NAME=${NAME:-sexton}
NETWORK=${NETWORK:-phattvip}
APPDATA=${APPDATA:-/mnt/user/appdata/sexton}
CHANNEL=${CHANNEL:-General Shit}
NICK=${NICK:-Sexton}
TS_HOST=${TS_HOST:-teamspeak6-server}
TS_PORT=${TS_PORT:-9987}
WHISPER_THREADS=${WHISPER_THREADS:-4}

log() { printf '\n== %s\n' "$*"; }

mkdir -p "$APPDATA/logs" "$APPDATA/config"

# The identity is the bot's server-side UID and its permissions. It used to be
# read from /mnt/user/scratch/sexton/sexton-id.txt at deploy time and passed on
# the command line, where `docker inspect` shows it to anyone on the box. It
# now lives in the mounted config dir instead. Migrate the old one once.
if [ ! -s "$APPDATA/config/sexton-id.txt" ] && [ -s /mnt/user/scratch/sexton/sexton-id.txt ]; then
  log "migrating the bot identity into $APPDATA/config"
  install -m 0600 /mnt/user/scratch/sexton/sexton-id.txt "$APPDATA/config/sexton-id.txt"
fi
if [ ! -s "$APPDATA/config/sexton-id.txt" ]; then
  echo "WARNING: no identity at $APPDATA/config/sexton-id.txt." >&2
  echo "         The bot will generate one, print it once, and come up as a new" >&2
  echo "         unprivileged account. Copy it out of 'docker logs $NAME' into" >&2
  echo "         that file before the next restart." >&2
fi

log "stopping the old stack"
docker rm -f "$NAME" >/dev/null 2>&1 || true
# The sidecars this image absorbs. Removing them here is the whole point of the
# issue: leaving `whisper` up would mean two transcribers and a stale one that
# the plugin might still be pointed at.
for old in ts-bridge whisper; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$old"; then
    echo "removing superseded container: $old"
    docker rm -f "$old" >/dev/null 2>&1 || true
  fi
done

log "starting $NAME from $IMAGE"
docker run -d \
  --name "$NAME" \
  --network "$NETWORK" \
  --restart unless-stopped \
  -e RUST_LOG=info \
  -e SEXTON_ADDR="$TS_HOST" \
  -e SEXTON_PORT="$TS_PORT" \
  -e SEXTON_NICK="$NICK" \
  -e SEXTON_CHANNEL="$CHANNEL" \
  -e SEXTON_LOG_DIR=/var/sexton-logs \
  -e SEXTON_IDENTITY_FILE=/config/sexton-id.txt \
  -e SEXTON_AVATAR=/usr/local/share/sexton-avatar/brandon.png \
  -e WHISPER_THREADS="$WHISPER_THREADS" \
  -v "$APPDATA/logs":/var/sexton-logs \
  -v "$APPDATA/config":/config \
  "$IMAGE"

log "waiting for health"
for _ in $(seq 1 40); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo unknown)
  [ "$status" = "healthy" ] && break
  [ "$status" = "unhealthy" ] && break
  sleep 5
done
docker inspect -f "$NAME: {{.State.Status}} health={{.State.Health.Status}}" "$NAME"

cat <<EOF

== the gateway side ==
The OpenClaw teamspeak plugin stays in the main gateway (option (b) — see
image/README.md, "Where the OpenClaw plugin runs"). Two things point it here:

1. Bind-mount the exported tools so the plugin spawns the yt-dlp/ffmpeg THIS
   image pinned, not whatever the gateway image happens to have (it has
   neither):
     docker cp ${NAME}:/opt/sexton-tools/. ${APPDATA}/tools/
   then add ${APPDATA}/tools -> /opt/sexton-tools (read-only) to the OpenClaw
   container's path mappings.

2. Channel config, in the gateway:
     "channels": { "teamspeak": {
       "bridgeUrl": "ws://${NAME}:9099",
       "channel": "${CHANNEL}",
       "voice": {
         "mode": "stt-tts",
         "streaming": {
           "transcription": { "provider": "whisper-local",
                              "url": "http://${NAME}:8080/inference" }
         }
       },
       "tools": { "music": {
         "ytdlpPath": "/opt/sexton-tools/yt-dlp",
         "ffmpegPath": "/opt/sexton-tools/ffmpeg",
         "extraYtdlpArgs": ["--extractor-args",
                            "youtubepot-bgutilhttp:base_url=http://${NAME}:4416"]
       } }
     } }

Both the bridge and whisper resolve by container name because OpenClaw is
already on the ${NETWORK} network. Nothing is published to the host.
EOF
