#!/usr/bin/env bash
# PHA-3554: deploy Bexton — the band leader — as a SECOND container from the
# same image the Sexton runs. Same binary, same bridge, same gateway; a
# different TeamSpeak identity, a different agent in the chair, and the house
# band switched on.
#
# This is image/deploy.sh with the persona knobs set. It does NOT touch the
# Sexton, the main gateway, or their configs:
#   - a different NAME/APPDATA, so nothing collides on disk;
#   - DISABLE_MAIN_TEAMSPEAK=0, because the Sexton's deploy already did that and
#     doing it again would restart the main gateway for nothing;
#   - IMPORT_FROM=sexton, so the gateway credentials come from the config that
#     is known to work on this lane (sonnet-5, the MiniMax TTS voice, the
#     /config workspace paths) rather than the main gateway's defaults;
#   - its own identity file. The first boot generates one and prints it; copy
#     it out of `docker logs bexton` into $APPDATA/config/sexton-id.txt before
#     the next restart, then give that identity the Sexton's server group in
#     the TS6 GUI. Until then Bexton is an unprivileged stranger.
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
# /config/band/ that writes the file itself.
#
# Lives on the box at /mnt/user/appdata/bexton/deploy-bexton.sh.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

export NAME=${NAME:-bexton}
export NICK=${NICK:-Bexton}
export APPDATA=${APPDATA:-/mnt/user/appdata/bexton}
export CHANNEL=${CHANNEL:-General Shit}
export AGENT_ID=${AGENT_ID:-bexton}
export WAKE_NAMES=${WAKE_NAMES:-Bexton,band leader,maestro}
# PHA-3605: no heard-aliases yet (24h of bexton's declined log showed no
# misheard form of the name); never answer the Sexton's names.
export WAKE_ALIASES=${WAKE_ALIASES-}
export EXCLUDE_WAKE_NAMES=${EXCLUDE_WAKE_NAMES-Sexton,Henchman}
# Not the Sexton's English_WiseScholar (Brandon, 2026-09-18). A bossy leader
# "speaking unconcernedly with an air of command"; English_ManWithDeepVoice is
# the other fit if this one reads too flat.
export TTS_VOICE_ID=${TTS_VOICE_ID:-English_BossyLeader}
export BAND_ENABLED=1
# suno-api since 2026-09-18 (Brandon's pick after MiniMax closed its Music API to
# the account): the `suno-api` container from image/suno-api/deploy.sh, on the
# same phattvip network. BAND_PROVIDER=minimax still works for a paying account.
export BAND_PROVIDER=${BAND_PROVIDER:-suno-api}
export BAND_SUNO_API_URL=${BAND_SUNO_API_URL:-http://suno-api:3000}
export BAND_NAME=${BAND_NAME:-The Velvet Vice Lounge Band}
# Pipe-separated other billings (Brandon, 2026-09-18). Used in a minority of intros.
export BAND_ALIASES=${BAND_ALIASES-Sgt. Bexton and the Digital Heart Club Band}
export WHISPER_THREADS=${WHISPER_THREADS:-2}
# PHA-3598: bexton's worker in the shared whisper pool is the second port.
export SEXTON_WHISPER_URL=${SEXTON_WHISPER_URL-http://whisper:8081/inference}
# Baked into the image from image/bexton/avatar/bexton.png (Brandon, 2026-09-18).
# A PNG at $APPDATA/config/avatar.png overrides it: AVATAR=/config/avatar.png.
export AVATAR=${AVATAR:-/usr/local/share/sexton-avatar/bexton.png}
export DISABLE_MAIN_TEAMSPEAK=0
export IMPORT_FROM=${IMPORT_FROM:-sexton}
export IMPORT_CONFIG_PATH=${IMPORT_CONFIG_PATH:-/config/openclaw/openclaw.json}

mkdir -p "$APPDATA/config/band-songs" "$APPDATA/config/band"

exec "$HERE/deploy.sh" "$@"
