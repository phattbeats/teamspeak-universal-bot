#!/usr/bin/env sh
# Env -> argv wrapper for the standalone plnt-ts-bridge image (PHA-3798).
#
# The `sexton` binary itself only takes CLI flags (see src/main.rs) — there
# is no clap `env` wiring, on purpose, because the one place it used to run
# (image/run-gateway.sh, the all-in-one Sexton/Bexton image) already owns
# its own env->argv translation for the SEXTON_* namespace. This script is
# a second, independent translation for people who are NOT running that
# image: someone with their own OpenClaw gateway who just wants the bridge
# half in a container. It deliberately uses a different env prefix
# (TS_BRIDGE_*, not SEXTON_*) so the two are never confused for each other
# in a compose file that happens to reference both.
set -eu

set -- sexton

if [ -n "${TS_BRIDGE_ADDRESS:-}" ]; then
  set -- "$@" --address "$TS_BRIDGE_ADDRESS"
fi
if [ -n "${TS_BRIDGE_PORT:-}" ]; then
  set -- "$@" --port "$TS_BRIDGE_PORT"
fi
if [ "${TS_BRIDGE_PUBLIC_FALLBACK:-0}" = "1" ]; then
  set -- "$@" --public-fallback
fi
if [ -n "${TS_BRIDGE_NICKNAME:-}" ]; then
  set -- "$@" --nickname "$TS_BRIDGE_NICKNAME"
fi

if [ -z "${TS_BRIDGE_CHANNEL:-}" ]; then
  echo "plnt-ts-bridge: TS_BRIDGE_CHANNEL is required (the TeamSpeak channel name to sit in)" >&2
  exit 1
fi
set -- "$@" --channel "$TS_BRIDGE_CHANNEL"

if [ -n "${TS_BRIDGE_CHANNEL_PASSWORD:-}" ]; then
  set -- "$@" --channel-password "$TS_BRIDGE_CHANNEL_PASSWORD"
fi

# Identity is a FILE here (item 2's ask), even though `sexton --identity`
# itself takes the raw "<counter>V<base64>" string — see src/main.rs. A
# stranger's first boot has no identity yet: sexton generates one, logs it
# once at warn level, and keeps running as that identity for the life of
# the process. Nothing captures that line automatically on purpose — the
# only proven-safe pinning step (used internally for Sexton/Bexton too,
# see PHA-3554) is a human copying the exact printed string into the file
# before the *next* restart. Silently parsing tracing output and writing
# whatever it found back to disk risks pinning a corrupt identity with no
# one noticing, which is worse than the manual step it would replace.
IDENTITY_FILE="${TS_BRIDGE_IDENTITY_FILE:-/data/identity.txt}"
if [ -s "$IDENTITY_FILE" ]; then
  identity=$(cat "$IDENTITY_FILE")
  set -- "$@" --identity "$identity"
else
  echo "plnt-ts-bridge: no identity at $IDENTITY_FILE yet." >&2
  echo "plnt-ts-bridge: sexton will generate one and log it as identity=<counter>V<key>." >&2
  echo "plnt-ts-bridge: copy that exact value into $IDENTITY_FILE (on the mounted volume) before the next restart, or this bot gets a new TeamSpeak identity every boot." >&2
fi

if [ -n "${TS_BRIDGE_AVATAR_PATH:-}" ]; then
  set -- "$@" --avatar-path "$TS_BRIDGE_AVATAR_PATH"
fi
if [ -n "${TS_BRIDGE_LOG_DIR:-}" ]; then
  set -- "$@" --log-dir "$TS_BRIDGE_LOG_DIR"
fi
if [ "${TS_BRIDGE_NO_CATCHUP:-0}" = "1" ]; then
  set -- "$@" --no-catchup
fi
if [ -n "${TS_BRIDGE_WS_BIND:-}" ]; then
  set -- "$@" --ws-bind "$TS_BRIDGE_WS_BIND"
fi
if [ -n "${TS_BRIDGE_DUCK_GAIN:-}" ]; then
  set -- "$@" --duck-gain "$TS_BRIDGE_DUCK_GAIN"
fi

exec "$@"
