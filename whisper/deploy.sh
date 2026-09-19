#!/bin/bash
# PHA-3598: the shared whisper pool for sexton + bexton on PHATT-RAID.
#
# Runs the `phattbeats/sexton` image (whisper.cpp + base.en are baked into it,
# PHA-3428) as a third container named `whisper`, with run-whisper-pool.sh as
# the entrypoint instead of supervisord: N whisper-server processes on
# consecutive ports, one per bot, silero VAD in front of each. The bots are
# pointed at it by image/deploy.sh (SEXTON_WHISPER_URL) and leave their own
# in-container server down (WHISPER_ENABLED=0).
#
# Port 8080/8081 are deliberately NOT published to the host: the point of a
# local transcriber is that channel audio never leaves the box.
#
# PHATT-RAID has no docker compose plugin, hence `docker run`. Idempotent:
# re-running replaces the container in place (the bots reconnect per request,
# so a pool restart costs one dropped segment, not a bot restart).
#
# Lives on the box at /mnt/user/appdata/whisper/deploy.sh.
set -eu

IMAGE=${IMAGE:-phattbeats/sexton:latest}
NAME=${NAME:-whisper}
NETWORK=${NETWORK:-phattvip}
APPDATA=${APPDATA:-/mnt/user/appdata/whisper}
WORKERS=${WORKERS:-2}
THREADS=${THREADS:-4}
MEMORY=${MEMORY:-1500m}
VAD_MODEL_URL=${VAD_MODEL_URL:-https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin}

HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$APPDATA/models"

# The pool script is mounted, not baked: it is the one file a live tuning pass
# (threads, VAD threshold, worker count) has to edit, and the image is the
# bot's image, rebuilt on the bot's schedule, not this one's.
if [ "$HERE/run-whisper-pool.sh" != "$APPDATA/run-whisper-pool.sh" ]; then
  cp "$HERE/run-whisper-pool.sh" "$APPDATA/run-whisper-pool.sh"
fi
chmod +x "$APPDATA/run-whisper-pool.sh"

if [ ! -s "$APPDATA/models/ggml-silero-v5.1.2.bin" ]; then
  echo "deploy: fetching the silero VAD model"
  curl -fsSL --max-time 120 -o "$APPDATA/models/ggml-silero-v5.1.2.bin" "$VAD_MODEL_URL"
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d \
  --name "$NAME" \
  --network "$NETWORK" \
  --restart unless-stopped \
  --no-healthcheck \
  --memory "$MEMORY" \
  -e LD_LIBRARY_PATH=/opt/whisper/bin \
  -e WHISPER_WORKERS="$WORKERS" \
  -e WHISPER_THREADS="$THREADS" \
  -v "$APPDATA:/whisper-data" \
  --entrypoint /whisper-data/run-whisper-pool.sh \
  "$IMAGE"

echo "deploy: waiting for the workers to load base.en"
for _ in $(seq 1 30); do
  sleep 2
  if docker logs "$NAME" 2>&1 | grep -q "whisper_init_state: compute buffer (decode)"; then
    break
  fi
done
docker logs "$NAME" 2>&1 | grep -E "run-whisper-pool|VAD is enabled" | head -4
echo "deploy: $NAME up on $NETWORK — sexton -> http://$NAME:8080/inference, bexton -> http://$NAME:8081/inference"
