#!/usr/bin/env bash
# PHA-3819: deploy Lexton Luthor — the villain — as a THIRD container from the
# sexton image, same pattern as deploy-bexton.sh (PHA-3554).
#
# PHA-3836: now a PERSONA=lexton deploy (PHA-3791). Wake names, aliases,
# excludes and the MiniMax voice come from personas/lexton/voice.json; the
# avatar is personas/lexton/avatar.png baked in as sexton-avatar/lexton.png.
# All of that is first-boot only: on the live bot the teamspeak block in
# $APPDATA/config/openclaw/openclaw.json (including the hand-set moderation
# grants, kick+move for everyone per PHA-3818) is never rewritten.
#
# Wake names (PHA-3605 trap): "Lexton" is one edit from Sexton AND Bexton.
# The matcher's onset rule already refuses s-/b- hearings for an l- name, and
# the other bots' names are excluded (ties go to them). "Lex" is NOT a fuzzy
# wake name — with a 3-letter key it would open on let/led/leg — it is an
# exact-only alias instead. The extra excludes are common l- words within
# two edits of "lexton" that would otherwise junk-open the gate.
#
# Lives on the box at /mnt/user/appdata/lexton/deploy-lexton.sh.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

export PERSONA=lexton
# PHA-3818: Lexton sends neither the welcome PM (the stock one names the
# Sexton) nor the catch-up recap.
export SEXTON_NO_CATCHUP=${SEXTON_NO_CATCHUP:-1}
export SEXTON_NO_WELCOME=${SEXTON_NO_WELCOME:-1}
# PHA-3818: random menacing DMs every 20-60 min (image/run-menace.sh).
export SEXTON_MENACE=${SEXTON_MENACE:-1}
export BAND_ENABLED=0
# Third worker in the shared whisper pool (whisper/deploy.sh WORKERS=3).
export WHISPER_THREADS=${WHISPER_THREADS:-2}
export SEXTON_WHISPER_URL=${SEXTON_WHISPER_URL-http://whisper:8082/inference}
export DISABLE_MAIN_TEAMSPEAK=0
export IMPORT_FROM=${IMPORT_FROM:-sexton}
export IMPORT_CONFIG_PATH=${IMPORT_CONFIG_PATH:-/config/openclaw/openclaw.json}
exec "$HERE/deploy.sh" "$@"
