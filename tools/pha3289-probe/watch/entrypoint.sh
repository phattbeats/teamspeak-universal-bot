#!/bin/sh
# PHA-3289 stream-watch container entrypoint (python:3.11-bookworm base).
# Installs the runtime deps for the Rust binary + the aiortc viewer helper,
# reusing a persistent venv on the bind mount so restarts are fast.
set -e

echo "[entrypoint] apt deps"
apt-get update -qq >/dev/null 2>&1 || true
apt-get install -y -qq --no-install-recommends \
    libopus0 libasound2 libssl3 ca-certificates >/dev/null 2>&1 || true

VENV=/data/watch/venv
if [ ! -x "$VENV/bin/python" ]; then
    echo "[entrypoint] creating venv + installing aiortc/av/pillow (first boot only)"
    python -m venv "$VENV"
    "$VENV/bin/pip" install --no-cache-dir -q --upgrade pip >/dev/null 2>&1 || true
    "$VENV/bin/pip" install --no-cache-dir -q aiortc av pillow >/dev/null 2>&1
fi
echo "[entrypoint] python ready: $("$VENV/bin/python" -c 'import aiortc,av,PIL;print(aiortc.__version__)')"

export VIEWER_PY="$VENV/bin/python"
export VIEWER_SCRIPT=/data/watch/viewer.py
echo "[entrypoint] exec stream-watch"
exec /data/watch/stream-watch "$@"
