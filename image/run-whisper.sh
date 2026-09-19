#!/bin/sh
# PHA-3428: whisper.cpp's HTTP server, in-container (was the `whisper` sidecar).
#
# Flags are the ones whisper/deploy.sh proved in PHA-3228 — keep them in step.
# `--convert` is load-bearing: the plugin posts whatever ffmpeg handed it, and
# without it whisper-server rejects anything that is not already 16 kHz mono wav.
#
# Binds 0.0.0.0 so the gateway container can reach it by name on `phattvip`.
# That is only safe because the port is never published to the host — see the
# EXPOSE note in the Dockerfile.
set -eu

: "${WHISPER_MODEL_PATH:=/opt/whisper/models/ggml-base.en.bin}"
: "${WHISPER_PORT:=8080}"
: "${WHISPER_THREADS:=4}"
: "${WHISPER_LANGUAGE:=en}"

if [ ! -s "$WHISPER_MODEL_PATH" ]; then
  echo "run-whisper: no model at $WHISPER_MODEL_PATH — the STT lane is down." >&2
  # Fail loudly and let supervisord back off rather than exiting 0: a silently
  # absent transcriber looks, from the channel, exactly like a bot that ignores
  # you.
  exit 1
fi

echo "run-whisper: $(basename "$WHISPER_MODEL_PATH") on :$WHISPER_PORT, ${WHISPER_THREADS} threads"
exec /opt/whisper/bin/whisper-server \
  --model "$WHISPER_MODEL_PATH" \
  --host 0.0.0.0 \
  --port "$WHISPER_PORT" \
  --threads "$WHISPER_THREADS" \
  --language "$WHISPER_LANGUAGE" \
  --no-timestamps \
  --convert \
  --audio-ctx "${WHISPER_AUDIO_CTX:-768}" \
  --beam-size 1 \
  --best-of 1 \
  --no-fallback
