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

# PHA-3598: the ears moved back out to a shared `whisper` pool container
# (whisper/deploy.sh) so sexton and bexton stop running one decoder each. When
# the bot is pointed there (SEXTON_WHISPER_URL), this in-container server is
# dead weight: ~250 MB resident for nothing. Exit 0 and stay down — supervisord
# treats a clean exit here as "deliberately absent" (autorestart=unexpected).
if [ "${WHISPER_ENABLED:-1}" = "0" ]; then
  echo "run-whisper: disabled by WHISPER_ENABLED=0 — STT comes from ${SEXTON_WHISPER_URL:-the shared whisper pool}."
  # PHA-3836: idle rather than exit. An exit inside startsecs is a failed
  # start to supervisord no matter the exit code, so `exit 0` here looped
  # forever (BACKOFF every ~10s); the live bots hid it with autostart=false.
  exec sleep infinity
fi

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
