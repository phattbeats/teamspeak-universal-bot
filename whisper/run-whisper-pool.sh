#!/bin/sh
# PHA-3598: shared whisper.cpp pool for sexton + bexton (own container, base.en).
# whisper-server serialises requests behind one mutex and has no request-level
# parallelism flag, so the pool is N processes on consecutive ports; each bot is
# pointed at its own port. VAD (silero) trims non-speech before decode so room
# tone / music no longer costs a full 30s-window pass ("[ [ [ [" hallucinations).
#
# PHA-3607: also starts the coalescing proxy (coalescing-proxy.mjs) one port
# past the worker range. It fans out one decode to both bots when their
# independent segmenters close on the same utterance within a short window,
# instead of each bot decoding the same speech separately. Both bots should
# point their transcriber URL at this port, not at a worker port directly;
# set WHISPER_COALESCE_ENABLED=0 to go back to pinning each bot to its own
# worker (the pre-PHA-3607 behavior) without editing this script.
set -eu
: "${WHISPER_MODEL_PATH:=/opt/whisper/models/ggml-base.en.bin}"
: "${WHISPER_VAD_MODEL:=/whisper-data/models/ggml-silero-v5.1.2.bin}"
: "${WHISPER_WORKERS:=2}"
: "${WHISPER_BASE_PORT:=8080}"
: "${WHISPER_THREADS:=4}"
: "${WHISPER_LANGUAGE:=en}"
: "${WHISPER_VAD:=1}"
: "${WHISPER_COALESCE_ENABLED:=1}"
: "${WHISPER_COALESCE_PORT:=$((WHISPER_BASE_PORT + WHISPER_WORKERS))}"
[ -s "$WHISPER_MODEL_PATH" ] || { echo "no model at $WHISPER_MODEL_PATH" >&2; exit 1; }
VAD_ARGS=""
if [ "$WHISPER_VAD" = "1" ] && [ -s "$WHISPER_VAD_MODEL" ]; then
  VAD_ARGS="--vad --vad-model $WHISPER_VAD_MODEL --vad-threshold ${WHISPER_VAD_THRESHOLD:-0.5} --vad-min-speech-duration-ms 250 --vad-min-silence-duration-ms 100 --vad-speech-pad-ms 60"
fi
i=0
pids=""
backend_ports=""
while [ "$i" -lt "$WHISPER_WORKERS" ]; do
  port=$((WHISPER_BASE_PORT + i))
  backend_ports="${backend_ports:+$backend_ports,}$port"
  echo "run-whisper-pool: worker $i on :$port threads=$WHISPER_THREADS vad=${VAD_ARGS:+on}${VAD_ARGS:-off}"
  /opt/whisper/bin/whisper-server --model "$WHISPER_MODEL_PATH" --host 0.0.0.0 --port "$port" \
    --threads "$WHISPER_THREADS" --language "$WHISPER_LANGUAGE" --no-timestamps --convert \
    --tmp-dir /tmp --audio-ctx "${WHISPER_AUDIO_CTX:-768}" --beam-size 1 --best-of 1 --no-fallback \
    --no-speech-thold "${WHISPER_NO_SPEECH_THOLD:-0.6}" $VAD_ARGS &
  pids="$pids $!"
  i=$((i + 1))
done
if [ "$WHISPER_COALESCE_ENABLED" = "1" ]; then
  echo "run-whisper-pool: coalescing proxy on :$WHISPER_COALESCE_PORT backends=$backend_ports"
  WHISPER_COALESCE_PORT="$WHISPER_COALESCE_PORT" WHISPER_BACKEND_PORTS="$backend_ports" \
    node /whisper-data/coalescing-proxy.mjs &
  pids="$pids $!"
fi
trap 'kill $pids 2>/dev/null' TERM INT
# If any worker (or the proxy) dies, exit non-zero so Docker's restart policy
# relaunches the pool.
wait -n 2>/dev/null || wait
exit 1
