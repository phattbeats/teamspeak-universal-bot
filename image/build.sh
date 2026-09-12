#!/usr/bin/env bash
# PHA-3428: build the one-container Sexton image. Run this ON PHATT-RAID.
#
# The dev sandbox has no C toolchain, so it cannot compile tsclientlib — the
# box is the build host, as it has been for this whole epic. Unraid has docker
# but no compose plugin, so this is a plain `docker build`.
#
# Build context is the repo root: the Dockerfile needs the workspace Cargo.toml,
# bridge-proto/, sexton/, and image/ all at once.
#
# Usage, from a checkout on the box:
#   image/build.sh                       # tags :dev
#   TAG=pha-3428 image/build.sh          # tags :pha-3428 and :latest
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE=${IMAGE:-phattbeats/sexton}
TAG=${TAG:-dev}
ALSO_LATEST=${ALSO_LATEST:-0}
# Set WITH_POT=0 to skip the bgutil POT provider stage (faster build; music
# still works, it just gets challenged by YouTube more often).
WITH_POT=${WITH_POT:-1}
YTDLP_VERSION=${YTDLP_VERSION:-2026.08.19}
WHISPER_MODEL=${WHISPER_MODEL:-ggml-base.en.bin}
# The weights are ~148 MB and the Rust build tree is large; the whisper.cpp
# source image alone is 1.14 GB. 92%-full is the normal state of this box.
MIN_FREE_GB=${MIN_FREE_GB:-15}

log() { printf '\n== %s\n' "$*"; }

log "preflight"
command -v docker >/dev/null || { echo "no docker on PATH — run this on PHATT-RAID" >&2; exit 1; }
free_gb=$(df -BG --output=avail /var/lib/docker | tail -1 | tr -dc '0-9')
echo "free on /var/lib/docker: ${free_gb}G (want >= ${MIN_FREE_GB}G)"
if [ "${free_gb:-0}" -lt "$MIN_FREE_GB" ]; then
  echo "not enough room; 'docker image prune' reclaims the dangling layers" >&2
  exit 1
fi
[ -f "$REPO_ROOT/image/Dockerfile" ] || { echo "no image/Dockerfile under $REPO_ROOT" >&2; exit 1; }

log "build ${IMAGE}:${TAG}"
docker build \
  -f "$REPO_ROOT/image/Dockerfile" \
  --build-arg "WITH_POT=${WITH_POT}" \
  --build-arg "YTDLP_VERSION=${YTDLP_VERSION}" \
  --build-arg "WHISPER_MODEL=${WHISPER_MODEL}" \
  -t "${IMAGE}:${TAG}" \
  "$REPO_ROOT"

# Not the build exit code. A green build of the wrong tag has fooled us before
# (PHA-3220), and here there are four independent payloads that can each go
# missing without the build noticing — the model download in particular is a
# separate stage whose failure mode is an empty file, not an error.
log "verify the payloads actually landed in the image"
docker run --rm --entrypoint sh "${IMAGE}:${TAG}" -c '
  set -e
  fail=0
  check() { # label, test-command
    if eval "$2" >/dev/null 2>&1; then echo "  ok   $1"; else echo "  MISS $1"; fail=1; fi
  }
  check "sexton binary"       "/usr/local/bin/sexton --help"
  check "bridge-test"         "test -x /usr/local/bin/bridge-test"
  check "whisper-server"      "/opt/whisper/bin/whisper-server --help"
  check "whisper weights"     "test -s /opt/whisper/models/ggml-base.en.bin"
  check "ffmpeg"              "ffmpeg -version"
  check "yt-dlp"              "yt-dlp --version"
  check "exported tools"      "test -x /opt/sexton-tools/yt-dlp -a -x /opt/sexton-tools/ffmpeg"
  check "supervisord"         "supervisord --version"
  check "runner scripts"      "test -x /usr/local/bin/run-sexton -a -x /usr/local/bin/run-whisper -a -x /usr/local/bin/run-pot"
  if [ -f /opt/bgutil-pot/DISABLED ]; then
    echo "  note POT provider absent: $(cat /opt/bgutil-pot/DISABLED)"
  else
    check "POT server"        "test -f /opt/bgutil-pot/build/main.js"
    # The server on its own is half of it. Without the yt-dlp-side plugin,
    # yt-dlp reports "PO Token Providers: none" and never contacts the server --
    # a green build, a running service, and a feature that does nothing. That
    # exact failure shipped in the first pha-3428 build; do not drop this check.
    # Written out rather than routed through check() because the grep pattern
    # has to survive two levels of shell quoting.
    # Asserts on the plugin DIRECTORY being discovered, not on the
    # "PO Token Providers: bgutil" line — that one is youtube-specific debug and
    # printing it would make every image build depend on reaching YouTube.
    if yt-dlp --verbose --simulate about:blank 2>&1 | grep -q "Plugin directories:.*yt_dlp_plugins"; then
      echo "  ok   POT yt-dlp plugin discovered"
    else
      echo "  MISS POT yt-dlp plugin not on a path yt-dlp searches — it will"
      echo "       never contact the provider. Check the <package> level in"
      echo "       /etc/yt-dlp/plugins/<package>/yt_dlp_plugins."
      fail=1
    fi
  fi
  echo
  echo "  model: $(ls -lh /opt/whisper/models/ | tail -1)"
  echo "  yt-dlp: $(yt-dlp --version 2>/dev/null)"
  exit $fail
'

if [ "$ALSO_LATEST" = "1" ] || [ "$TAG" = "latest" ]; then
  docker tag "${IMAGE}:${TAG}" "${IMAGE}:latest"
  echo "also tagged ${IMAGE}:latest"
fi

log "built"
docker images "${IMAGE}" --format '{{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}' | head -5
echo
echo "Next: image/deploy.sh (docker run form), or the Unraid template in image/unraid-sexton.xml"
