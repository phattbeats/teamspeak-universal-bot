#!/bin/sh
# PHA-3428: one healthcheck for a container that now runs several things.
#
# What counts as healthy: the bot is in the channel and the bridge is
# listening. That is the pair the room actually notices. whisper is checked
# but NOT fatal — it can spend a minute loading the model, and it can be
# restarting after an OOM, and in neither case is the right answer to have
# Docker restart the container and take the bot out of the channel too. That
# isolation is the reason supervisord is here; the healthcheck has to respect
# it or it undoes it.
#
# PHA-3217's lesson stands: the runtime image has no pgrep, so process
# liveness is read off /proc, and `grep -a` because /proc/*/cmdline is
# NUL-separated.
set -u

: "${WHISPER_PORT:=8080}"
: "${SEXTON_WS_BIND:=0.0.0.0:9099}"
ws_port=${SEXTON_WS_BIND##*:}

fail=0

# 1. The Sexton process exists. supervisord is PID 1 now, so this is no longer
#    a /proc/1/cmdline check.
if ! grep -qla /usr/local/bin/sexton /proc/[0-9]*/cmdline 2>/dev/null; then
  echo "unhealthy: no sexton process"
  fail=1
fi

# 2. The bridge WebSocket is accepting. This is what the OpenClaw plugin dials;
#    a bot that is running but not listening is a voice lane that is silently
#    down.
if ! curl -fsS -m 5 -o /dev/null "http://127.0.0.1:${ws_port}/" 2>/dev/null; then
  # A WS server answers a plain GET with 400/426, not 200, and curl -f calls
  # that a failure — so a refused *connection* is the real signal. Distinguish
  # the two by asking curl for the exit code.
  curl -sS -m 5 -o /dev/null "http://127.0.0.1:${ws_port}/" 2>/dev/null
  rc=$?
  # 7 = couldn't connect, 28 = timed out. Anything else means something spoke.
  if [ "$rc" = 7 ] || [ "$rc" = 28 ]; then
    echo "unhealthy: bridge websocket not listening on :${ws_port} (curl rc=$rc)"
    fail=1
  fi
fi

# 3. whisper — reported, never fatal. See the header.
if curl -fsS -m 5 -o /dev/null "http://127.0.0.1:${WHISPER_PORT}/" 2>/dev/null; then
  echo "whisper: ready"
else
  echo "whisper: not ready (loading, restarting, or disabled) — not fatal"
fi

[ "$fail" = 0 ] && echo "healthy: sexton + bridge"
exit "$fail"
