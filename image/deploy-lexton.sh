#!/usr/bin/env bash
# PHA-3819: deploy Lexton Luthor — the villain — as a THIRD container from the
# sexton image, same pattern as deploy-bexton.sh (PHA-3554). No band, no
# moderation: kick+move for everyone (PHA-3818), set in openclaw.json by hand.
#
# Persona files (SOUL/IDENTITY/AGENTS/HUMAN) are pre-placed in
# $APPDATA/config/openclaw/workspace/agents/lexton; run-gateway never seeds
# over an existing workspace.
#
# Wake names (PHA-3605 trap): "Lexton" is one edit from Sexton AND Bexton.
# The matcher's onset rule already refuses s-/b- hearings for an l- name, and
# the other bots' names are excluded (ties go to them). "Lex" is NOT a fuzzy
# wake name — with a 3-letter key it would open on let/led/leg — it is an
# exact-only alias instead. The extra excludes are common l- words within
# two edits of "lexton" that would otherwise junk-open the gate.
#
# Lives on the box at /mnt/user/appdata/lexton/deploy-lexton.sh.
#
# PHA-3818 post-deploy step this script does NOT do (container-layer only):
#  - supervisor [program:menace] running `node /config/lexton-menace.cjs`
#    (random menacing DMs every 20-60 min; copy image/lexton/lexton-menace.cjs to $APPDATA/config/)
#  - tools.moderation + villain wake words in /config/openclaw/openclaw.json persist on their own.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

export NAME=${NAME:-lexton}
export NICK=${NICK:-Lexton}  # PHA-3818: bot name is Lexton, goes by Lexton Luthor
export APPDATA=${APPDATA:-/mnt/user/appdata/lexton}
export CHANNEL=${CHANNEL:-General Shit}
export AGENT_ID=${AGENT_ID:-lexton}
export WAKE_NAMES=${WAKE_NAMES:-Lexton,Luthor}
export WAKE_ALIASES=${WAKE_ALIASES-lex,lex luthor,lex luther,mr luthor,luther,lexin,lecton,lexten,lex ton}
export EXCLUDE_WAKE_NAMES=${EXCLUDE_WAKE_NAMES-Sexton,Bexton,Henchman,band leader,maestro,lesson,lessen,lessons,lemon,lepton,lexicon,left on,left one,lets on}
# Brandon's pick, PHA-3818 (2026-09-28).
export TTS_VOICE_ID=${TTS_VOICE_ID:-English_ManWithDeepVoice}
export BAND_ENABLED=0
export SEXTON_NO_CATCHUP=${SEXTON_NO_CATCHUP:-1}
# PHA-3818: Lexton sends no welcome PM (the stock one names the Sexton).
export SEXTON_NO_WELCOME=${SEXTON_NO_WELCOME:-1}
export WHISPER_THREADS=${WHISPER_THREADS:-2}
# Third worker in the shared whisper pool (whisper/deploy.sh WORKERS=3).
export SEXTON_WHISPER_URL=${SEXTON_WHISPER_URL-http://whisper:8082/inference}
export AVATAR=${AVATAR:-/config/avatar.png}  # PHA-3818 bald portrait
export DISABLE_MAIN_TEAMSPEAK=0
export IMPORT_FROM=${IMPORT_FROM:-sexton}
export IMPORT_CONFIG_PATH=${IMPORT_CONFIG_PATH:-/config/openclaw/openclaw.json}

exec "$HERE/deploy.sh" "$@"
