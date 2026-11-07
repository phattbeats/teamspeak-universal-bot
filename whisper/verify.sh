#!/bin/bash
# PHA-3228: prove the STT sidecar answers, and measure what it costs.
#
# The lane's definition of done is a latency budget ("hears the last messages
# within two seconds"), so this prints the round trip rather than just a pass:
# the STT stage is the one with the widest spread, and knowing its number is
# what decides speech-2.8-hd versus speech-2.8-turbo on the TTS side.
#
# Lives on the box at /mnt/user/appdata/whisper/verify.sh.
set -eu

URL=${URL:-http://127.0.0.1:8080/inference}
CONTAINER=${CONTAINER:-whisper}
WAV=${WAV:-/tmp/whisper-probe.wav}

# Speech, not a tone: a sine wave transcribes to [BLANK_AUDIO] and proves
# nothing about the model. ffmpeg's flite filter is the shortest path to words.
if [ ! -s "$WAV" ]; then
  if command -v ffmpeg >/dev/null && ffmpeg -hide_banner -filters 2>/dev/null | grep -q flite; then
    ffmpeg -y -loglevel error -f lavfi \
      -i "flite=text='sexton, what did I miss':voice=slt" \
      -ar 16000 -ac 1 "$WAV"
  else
    echo "no ffmpeg with the flite filter here." >&2
    echo "Record or copy a short 16 kHz mono WAV to $WAV and re-run." >&2
    exit 1
  fi
fi

echo "== posting $(du -h "$WAV" | cut -f1) to $URL"
start=$(date +%s%3N)
body=$(docker exec -i "$CONTAINER" sh -c "cat > /tmp/probe.wav && curl -fsS \
  -F file=@/tmp/probe.wav -F response_format=json -F temperature=0 '$URL'" < "$WAV")
elapsed=$(( $(date +%s%3N) - start ))

echo "$body"
echo "== round trip: ${elapsed}ms"
echo
echo "Budget note: the lane is segment-close -> STT -> agent -> TTS -> first"
echo "audio, targeting 1.5-3s. If STT alone is past ~800ms here, drop to a"
echo "smaller model before blaming MiniMax."
