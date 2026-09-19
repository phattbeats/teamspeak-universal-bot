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
# PHA-3428 option (a): the gateway that now runs INSIDE this image. Pin it to
# the same version the main gateway is on — two gateways drifting apart is the
# upgrade hazard PHA-3326 named, and pinning is the cheapest guard against it.
#   docker exec OpenClaw openclaw --version
OPENCLAW_VERSION=${OPENCLAW_VERSION:-2026.9.3}
# The weights are ~148 MB, the Rust build tree is large, the whisper.cpp source
# image alone is 1.14 GB, and the gateway base image adds ~2 GB on top of what
# this used to need. 92%-full is the normal state of this box.
MIN_FREE_GB=${MIN_FREE_GB:-20}

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
# PHA-3580: the plugin used to be staged here from a separate private repo
# (openclaw-teamspeak-plugin, split out by PHA-3220) via
# install/stage-teamspeak-link.sh. It now lives in this repo at
# teamspeak-plugin/, so the Dockerfile COPYs it straight from the build
# context (.dockerignore strips the test-only scaffolding) — there is nothing
# left to stage or clean up here.
[ -f "$REPO_ROOT/teamspeak-plugin/openclaw.plugin.json" ] || {
  echo "no teamspeak-plugin/openclaw.plugin.json under $REPO_ROOT" >&2
  exit 1
}

# Parse the gateway seed here, on the host, where the quoting is sane. A
# malformed seed does not fail the build — it fails at first boot, as a gateway
# that will not start, in the room.
docker run --rm -v "$REPO_ROOT/image/gateway":/g:ro --entrypoint node \
  "ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}" \
  -e 'JSON.parse(require("fs").readFileSync("/g/openclaw.seed.json","utf8")); console.log("gateway seed config parses")' \
  || { echo "image/gateway/openclaw.seed.json is not valid JSON" >&2; exit 1; }

log "build ${IMAGE}:${TAG}  (openclaw ${OPENCLAW_VERSION})"
docker build \
  -f "$REPO_ROOT/image/Dockerfile" \
  --build-arg "WITH_POT=${WITH_POT}" \
  --build-arg "YTDLP_VERSION=${YTDLP_VERSION}" \
  --build-arg "WHISPER_MODEL=${WHISPER_MODEL}" \
  --build-arg "OPENCLAW_VERSION=${OPENCLAW_VERSION}" \
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
  # PHA-3554: --help is not proof. The upstream :main image of 2026-09-17
  # passed --help and then died with SIGILL at the first inference on this
  # CPU. One second of silence through whisper-cli is the smallest thing that
  # actually executes the ggml kernels.
  ffmpeg -loglevel error -f lavfi -i anullsrc=r=16000:cl=mono -t 1 /tmp/silence.wav
  check "whisper inference"   "/opt/whisper/bin/whisper-cli -m /opt/whisper/models/ggml-base.en.bin -f /tmp/silence.wav -nt"
  check "ffmpeg"              "ffmpeg -version"
  check "yt-dlp"              "yt-dlp --version"
  check "supervisord"         "supervisord --version"
  check "runner scripts"      "test -x /usr/local/bin/run-sexton -a -x /usr/local/bin/run-whisper -a -x /usr/local/bin/run-pot -a -x /usr/local/bin/run-gateway"
  # --- PHA-3428 option (a): the gateway and its plugin ---
  # The gateway binary being present is not the interesting assertion — it
  # comes from the base image. The interesting one is the plugin: it is COPYd
  # out of a builder stage, it ships no dist/, and the npm install for its one
  # runtime dep is the step that can quietly no-op. A plugin directory with no
  # node_modules/ws link-installs cleanly and then fails at first message.
  check "openclaw gateway"    "openclaw --version"
  check "plugin manifest"     "test -f /opt/openclaw-teamspeak-plugin/openclaw.plugin.json"
  check "plugin entrypoint"   "test -f /opt/openclaw-teamspeak-plugin/index.ts"
  check "plugin deps (ws)"    "test -d /opt/openclaw-teamspeak-plugin/node_modules/ws"
  # The seed is parsed for real in the preflight above, on the host, where the
  # quoting is sane. A nested node -e in here is how you get a check that
  # silently never runs.
  check "gateway seed config" "test -s /opt/sexton-gateway/openclaw.seed.json"
  check "run-gateway links"   "grep -q plugins.install.--link /usr/local/bin/run-gateway"
  # The whole point of the seed is that every endpoint is loopback: under
  # option a the bridge/whisper/POT ports are not published and nothing outside
  # this container can reach them. A seed still carrying the option b
  # container-name URLs produces a gateway that silently never connects.
  #
  # No apostrophes and no single quotes anywhere in this block — it is the body
  # of a single-quoted sh -c, and either one ends the string early.
  if grep -qE "(ws|http)://(sexton|ts-bridge|whisper):" /opt/sexton-gateway/openclaw.seed.json; then
    echo "  MISS seed config still points at container names, not 127.0.0.1"
    fail=1
  else
    echo "  ok   seed config is loopback-only"
  fi
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
