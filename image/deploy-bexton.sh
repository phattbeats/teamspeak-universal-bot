#!/usr/bin/env bash
# PHA-3554: deploy Bexton — the band leader — as a SECOND container from the
# same image the Sexton runs. Same binary, same bridge, same gateway; a
# different TeamSpeak identity, a different agent in the chair, and the house
# band switched on.
#
# PHA-3791: this used to re-export every persona knob (wake names/aliases,
# TTS voice, band config, avatar) before handing off to image/deploy.sh. Those
# now have a home in personas/bexton/voice.json and personas/bexton/tools.json
# (baked into the image at /opt/sexton-persona/bexton.config/, consumed by
# run-gateway.sh on first boot — see that script's step 3), and
# NAME/APPDATA/AGENT_ID/NICK/AVATAR derive from PERSONA=bexton inside
# image/deploy.sh itself. What is left here is the handful of knobs that
# still have no sensible PERSONA-derived default: which lane the two whisper
# instances get, where this container imports its gateway credentials from,
# and that the Sexton's deploy already handled turning off the main gateway's
# teamspeak channel.
#
# This is image/deploy.sh with PERSONA=bexton. It does NOT touch the Sexton,
# the main gateway, or their configs — a different NAME/APPDATA (derived from
# PERSONA) means nothing collides on disk, and DISABLE_MAIN_TEAMSPEAK=0 below
# means this deploy does not restart the main gateway for nothing (the
# Sexton's deploy already did that).
#
# Its own identity file: the first boot generates one and prints it; copy it
# out of `docker logs bexton` into $APPDATA/config/sexton-id.txt before the
# next restart, then give that identity the Sexton's server group in the TS6
# GUI. Until then Bexton is an unprivileged stranger.
#
# Two whisper instances now run on the box (one per container). That is the
# real cost of a second persona; WHISPER_THREADS is set low here on purpose.
#
# Generator: SEE image/README.md "The house band" before running this. As of
# 2026-09-17 MiniMax's music endpoint refuses new accounts (2153), so the
# default provider only works if the MiniMax account behind the TTS key is
# already a paying music customer. The alternatives are BAND_PROVIDER=suno-api
# with BAND_SUNO_API_URL pointed at a self-hosted gcui-art/suno-api, or
# BAND_PROVIDER=command with BAND_COMMAND naming an executable under
# /config/band/ that writes the file itself. personas/bexton/tools.json's
# default is suno-api; both remain overridable by env exactly as before.
#
# Lives on the box at /mnt/user/appdata/bexton/deploy-bexton.sh.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

export PERSONA=bexton
export WHISPER_THREADS=${WHISPER_THREADS:-2}
# PHA-3607: both bots point at the pool's coalescing proxy (:8082), which
# fans one decode out to both bots when their segmenters close on the same
# utterance, and otherwise round-robins across the two workers (:8080/:8081)
# the same as pinning each bot to its own port used to.
export SEXTON_WHISPER_URL=${SEXTON_WHISPER_URL-http://whisper:8082/inference}
export DISABLE_MAIN_TEAMSPEAK=0
export IMPORT_FROM=${IMPORT_FROM:-sexton}
export IMPORT_CONFIG_PATH=${IMPORT_CONFIG_PATH:-/config/openclaw/openclaw.json}

APPDATA=${APPDATA:-/mnt/user/appdata/bexton}
mkdir -p "$APPDATA/config/band-songs" "$APPDATA/config/band"

exec "$HERE/deploy.sh" "$@"
