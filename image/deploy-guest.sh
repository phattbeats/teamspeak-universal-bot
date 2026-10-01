#!/usr/bin/env bash
# PHA-3842 G1: the guest-star slot. ONE container (`guest`) from the same
# image as the regulars, shared by every guest (Rotten Johnny, Trixie, ...).
# ts-summoner keeps its core stopped except during a visit, and before each
# visit runs /usr/local/bin/guest-switch.mjs <id> in here, which rebinds the
# teamspeak channel to that guest's agent, swaps wake names and TTS voice, and
# writes the nick/avatar the core picks up (/config/.guest-env).
#
# First boot comes up as Johnny (PERSONA=johnny), so the usual run-gateway.sh
# seeding gives a valid channel block and agent binding. guest-switch.mjs
# adds every other guest's agent and workspace on their first visit.
#
# Cost (PHA-3597): one guest container no matter how many guests, its core is
# off between visits, and it uses the shared whisper pool's coalescing proxy,
# so a guest in the room with Bexton mostly shares his decodes.
#
# One TeamSpeak identity for all guests: copy it out of `docker logs guest`
# into $APPDATA/config/sexton-id.txt after the first boot, same as any bot.
# It needs no server group; guests have no moderation tools.
#
# Lives on the box at /mnt/user/appdata/guest/deploy-guest.sh.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

export PERSONA=johnny
export NAME=${NAME:-guest}
export APPDATA=${APPDATA:-/mnt/user/appdata/guest}
export NICK=${NICK:-Rotten Johnny}
# Guests drop in; they don't send the welcome PM or the catch-up recap.
export SEXTON_NO_CATCHUP=${SEXTON_NO_CATCHUP:-1}
export SEXTON_NO_WELCOME=${SEXTON_NO_WELCOME:-1}
export BAND_ENABLED=0
export SEXTON_WHISPER_URL=${SEXTON_WHISPER_URL-http://whisper:8082/inference}
export DISABLE_MAIN_TEAMSPEAK=0
export IMPORT_FROM=${IMPORT_FROM:-sexton}
export IMPORT_CONFIG_PATH=${IMPORT_CONFIG_PATH:-/config/openclaw/openclaw.json}
exec "$HERE/deploy.sh" "$@"
