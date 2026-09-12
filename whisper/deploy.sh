#!/bin/bash
# PHA-3228 deploy for the local STT sidecar on PHATT-RAID.
#
# SUPERSEDED by image/deploy.sh (PHA-3428): the whole stack is one container
# now. Do NOT run this alongside it — two bots on one identity is a UID
# collision and the server drops one of them. Kept as the record of the
# settings this deploy proved; image/deploy.sh carries them forward.
#
# PHATT-RAID has no docker compose plugin, so this is the `docker run` form of
# whisper-compose.yml. Keep the two in step.
#
# Connect by container name on the TS6 server's own Docker network, the same as
# ts-bridge and sexton. Port 8080 is deliberately NOT published to the host:
# the point of this container is that the channel's audio does not leave the
# box, and an exposed port is the easiest way to lose that by accident.
#
# Lives on the box at /mnt/user/appdata/whisper/deploy.sh.
set -eu

IMG=${IMG:-ghcr.io/ggml-org/whisper.cpp:main}
MODEL=${MODEL:-ggml-base.en.bin}
MODEL_DIR=${MODEL_DIR:-/mnt/user/appdata/whisper/models}
THREADS=${THREADS:-4}
NETWORK=${NETWORK:-phattvip}

mkdir -p "$MODEL_DIR"

# The image ships the binaries, not the weights. Fetch once; a partial download
# is written to a temp name so a failed run cannot leave a truncated model that
# whisper-server then refuses at startup with an unhelpful error.
if [ ! -s "$MODEL_DIR/$MODEL" ]; then
  echo "== fetching $MODEL"
  curl -fL --retry 3 -o "$MODEL_DIR/$MODEL.part" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"
  mv "$MODEL_DIR/$MODEL.part" "$MODEL_DIR/$MODEL"
fi
echo "model: $MODEL_DIR/$MODEL ($(du -h "$MODEL_DIR/$MODEL" | cut -f1))"

docker rm -f whisper >/dev/null 2>&1 || true
docker run -d --name whisper --network "$NETWORK" --restart unless-stopped \
  -v "$MODEL_DIR:/models:ro" \
  --health-cmd "curl -fsS http://127.0.0.1:8080/ >/dev/null || exit 1" \
  --health-interval 30s --health-timeout 5s --health-retries 3 \
  --health-start-period 60s \
  "$IMG" \
  "whisper-server --model /models/$MODEL --host 0.0.0.0 --port 8080 \
     --threads $THREADS --language en --no-timestamps --convert"

echo "== waiting for the model to load"
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' whisper 2>/dev/null || echo unknown)
  [ "$status" = "healthy" ] && break
  sleep 5
done
docker inspect -f 'whisper: {{.State.Status}} health={{.State.Health.Status}}' whisper

cat <<'NEXT'

Next: point the plugin at it. In the gateway's config,

  "channels": { "teamspeak": { "voice": {
    "mode": "stt-tts",
    "wakeNames": ["Sexton"],
    "requireWakeName": true,
    "streaming": {
      "transcription": { "provider": "whisper-local" },
      "speech": { "provider": "minimax", "model": "speech-2.8-hd" }
    }
  } } }

The transcription url defaults to http://whisper:8080/inference, which is this
container on this network. Override with voice.streaming.transcription.url or
TEAMSPEAK_WHISPER_URL only if you moved it.
NEXT
