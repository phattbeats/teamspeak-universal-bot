#!/bin/sh
# PHA-3598: shared whisper.cpp pool for sexton + bexton (own container, base.en).
# whisper-server serialises requests behind one mutex and has no request-level
# parallelism flag, so the pool is N processes on consecutive ports; each bot is
# pointed at its own port. VAD (silero) trims non-speech before decode so room
# tone / music no longer costs a full 30s-window pass ("[ [ [ [" hallucinations).
set -eu
: "${WHISPER_MODEL_PATH:=/opt/whisper/models/ggml-base.en.bin}"
: "${WHISPER_VAD_MODEL:=/whisper-data/models/ggml-silero-v5.1.2.bin}"
: "${WHISPER_WORKERS:=2}"
: "${WHISPER_BASE_PORT:=8080}"
: "${WHISPER_THREADS:=4}"
: "${WHISPER_LANGUAGE:=en}"
: "${WHISPER_VAD:=1}"
[ -s "$WHISPER_MODEL_PATH" ] || { echo "no model at $WHISPER_MODEL_PATH" >&2; exit 1; }
VAD_ARGS=""
if [ "$WHISPER_VAD" = "1" ] && [ -s "$WHISPER_VAD_MODEL" ]; then
  VAD_ARGS="--vad --vad-model $WHISPER_VAD_MODEL --vad-threshold ${WHISPER_VAD_THRESHOLD:-0.5} --vad-min-speech-duration-ms 250 --vad-min-silence-duration-ms 100 --vad-speech-pad-ms 60"
fi
i=0
pids=""
while [ "$i" -lt "$WHISPER_WORKERS" ]; do
  port=$((WHISPER_BASE_PORT + i))
  echo "run-whisper-pool: worker $i on :$port threads=$WHISPER_THREADS vad=${VAD_ARGS:+on}${VAD_ARGS:-off}"
  /opt/whisper/bin/whisper-server --model "$WHISPER_MODEL_PATH" --host 0.0.0.0 --port "$port" \
    --threads "$WHISPER_THREADS" --language "$WHISPER_LANGUAGE" --no-timestamps --convert \
    --tmp-dir /tmp --audio-ctx "${WHISPER_AUDIO_CTX:-768}" --beam-size 1 --best-of 1 --no-fallback \
    --no-speech-thold "${WHISPER_NO_SPEECH_THOLD:-0.6}" $VAD_ARGS &
  pids="$pids $!"
  i=$((i + 1))
done
trap 'kill $pids 2>/dev/null' TERM INT
# If any worker dies, exit non-zero so Docker's restart policy relaunches the pool.
wait -n 2>/dev/null || wait
exit 1
