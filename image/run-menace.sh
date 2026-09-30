#!/bin/sh
# PHA-3836: Lexton's menacing DMs (PHA-3818), formerly a hand-added,
# container-layer-only supervisor stanza that every recreate wiped. Now baked
# in and gated: exit 0 and stay down unless SEXTON_MENACE=1 (supervisord treats
# a clean exit as "deliberately absent", same as run-whisper). The script lives
# in the image; a /config/lexton-menace.cjs, if present, wins so it can be
# tuned live without a rebuild.
set -eu
if [ "${SEXTON_MENACE:-0}" != "1" ]; then
  echo "run-menace: disabled (SEXTON_MENACE is not 1)."
  exit 0
fi
script=/opt/sexton-menace/lexton-menace.cjs
[ -f /config/lexton-menace.cjs ] && script=/config/lexton-menace.cjs
exec /usr/bin/env node "$script"
