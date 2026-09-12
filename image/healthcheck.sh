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

# 4. The in-container OpenClaw gateway (PHA-3428 option (a)) — reported, never
#    fatal, for the same reason as whisper and more so. The gateway is the
#    slowest thing in here to come up, and restarting the CONTAINER because it
#    is mid-boot would drop the bot out of the channel and lose the bridge —
#    the exact failure the supervisor exists to prevent. supervisord already
#    restarts it on its own if it actually dies.
#
#    Skipped entirely when the gateway is deliberately off (the rollback-to-(b)
#    switch), so that configuration does not print a permanent scary line.
: "${SEXTON_GATEWAY_PORT:=18789}"
: "${SEXTON_GATEWAY_ENABLED:=1}"
if [ "$SEXTON_GATEWAY_ENABLED" != "1" ]; then
  echo "gateway: disabled (SEXTON_GATEWAY_ENABLED=0)"
elif curl -fsS -m 5 -o /dev/null "http://127.0.0.1:${SEXTON_GATEWAY_PORT}/" 2>/dev/null; then
  echo "gateway: ready"
else
  # Same curl-exit-code reasoning as the bridge check above: a refused
  # connection means not listening; anything else means it spoke and simply did
  # not like an unauthenticated GET, which is a gateway that is up.
  curl -sS -m 5 -o /dev/null "http://127.0.0.1:${SEXTON_GATEWAY_PORT}/" 2>/dev/null
  grc=$?
  if [ "$grc" = 7 ] || [ "$grc" = 28 ]; then
    echo "gateway: not listening on :${SEXTON_GATEWAY_PORT} (starting, or crashed) — not fatal"
  else
    echo "gateway: ready"
  fi
fi

[ "$fail" = 0 ] && echo "healthy: sexton + bridge"
exit "$fail"
