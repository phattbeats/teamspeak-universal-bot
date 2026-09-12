#!/bin/sh
# PHA-3428: env -> argv for the Sexton binary.
#
# The bot's configuration is clap flags, and supervisord programs are a fixed
# command line. The issue asks for "config via env + one mounted config dir", so
# this wrapper is the seam: env vars in, `exec sexton` with the right flags out.
# Deliberately a wrapper and not a change to the binary's arg parsing — the flags
# are what PHA-3173/3215's deploy, verify.sh, and every transcript in the epic
# are written against, and they stay the interface.
#
# `exec` matters: supervisord signals this PID, and without exec the TERM would
# hit /bin/sh and leave the bot to be SIGKILLed, which loses the last
# disconnect and leaves a ghost session the server reaps ~150s later.
set -eu

: "${SEXTON_ADDR:=teamspeak6-server}"
: "${SEXTON_PORT:=9987}"
: "${SEXTON_NICK:=Sexton}"
: "${SEXTON_CHANNEL:=General Shit}"
: "${SEXTON_LOG_DIR:=/var/sexton-logs}"
: "${SEXTON_AVATAR:=}"
: "${SEXTON_CHANNEL_PASSWORD:=}"
: "${SEXTON_WS_BIND:=0.0.0.0:9099}"
: "${SEXTON_DUCK_GAIN:=0.25}"
: "${SEXTON_IDENTITY:=}"
: "${SEXTON_IDENTITY_FILE:=/config/sexton-id.txt}"

# The identity is the bot's server-side UID: lose it and the Sexton comes back
# as a stranger with no permissions and no history. Prefer the mounted config
# dir (survives an image rebuild) over an env var (visible in `docker inspect`).
# Empty is legal — the binary generates one and prints it once; grab it out of
# the log and write it to the config dir before the next restart.
if [ -z "$SEXTON_IDENTITY" ] && [ -s "$SEXTON_IDENTITY_FILE" ]; then
  SEXTON_IDENTITY=$(tr -d '\r\n' < "$SEXTON_IDENTITY_FILE")
fi
if [ -z "$SEXTON_IDENTITY" ]; then
  echo "run-sexton: WARNING no identity in \$SEXTON_IDENTITY or $SEXTON_IDENTITY_FILE;" \
       "the bot will generate one and come up as a new, unprivileged account." >&2
fi

mkdir -p "$SEXTON_LOG_DIR"

set -- \
  --address "$SEXTON_ADDR" \
  --port "$SEXTON_PORT" \
  --nickname "$SEXTON_NICK" \
  --channel "$SEXTON_CHANNEL" \
  --log-dir "$SEXTON_LOG_DIR" \
  --ws-bind "$SEXTON_WS_BIND" \
  --duck-gain "$SEXTON_DUCK_GAIN" \
  --identity "$SEXTON_IDENTITY" \
  --channel-password "$SEXTON_CHANNEL_PASSWORD"

# Only pass the avatar when the file is actually there. The binary treats a
# missing path as "no avatar" anyway, but passing a path that does not exist
# reads, in the log, exactly like an upload that failed.
if [ -n "$SEXTON_AVATAR" ] && [ -f "$SEXTON_AVATAR" ]; then
  set -- "$@" --avatar-path "$SEXTON_AVATAR"
fi
if [ -n "${SEXTON_TTS_WEBHOOK_URL:-}" ]; then
  set -- "$@" --tts-webhook-url "$SEXTON_TTS_WEBHOOK_URL"
fi
if [ -n "${SEXTON_ON_CONNECTED:-}" ]; then
  set -- "$@" --on-connected "$SEXTON_ON_CONNECTED"
fi

echo "run-sexton: $SEXTON_NICK -> $SEXTON_ADDR:$SEXTON_PORT channel='$SEXTON_CHANNEL' ws=$SEXTON_WS_BIND"
exec /usr/local/bin/sexton "$@"
