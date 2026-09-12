# PHA-3428: the whole Sexton stack as ONE image.
#
# Brandon's decision 2026-09-12: one image, one container, one Unraid template
# entry. Everything the Sexton needs to keep the hall — text, voice, ears, and
# music — lives in here, supervised, and comes back on its own when one piece
# dies.
#
# What is inside, and why each piece is here rather than beside it:
#
#   sexton          The bot. Since PHA-3342 this one binary is also the audio
#                   bridge PHA-3174 used to run as `ts-bridge`: one tsclientlib
#                   connection, one bot account, and the bridge WebSocket on
#                   :9099 that the OpenClaw teamspeak plugin dials.
#   whisper-server  whisper.cpp's HTTP server plus `ggml-base.en.bin`, BAKED IN
#                   (PHA-3228). Formerly the `whisper` sidecar container. The
#                   weights are ~148 MB and they are the single reason the STT
#                   lane costs $0 and never leaves the box, so they ship with
#                   the image rather than being fetched on first boot into a
#                   host directory somebody can forget to back up.
#   ffmpeg, yt-dlp  The PHA-3176 music lane, plus the ffmpeg the stt-tts lane
#   + POT provider  decodes TTS with. See the long note in image/README.md
#                   about WHERE these run — they are spawned by the plugin, in
#                   the gateway, so the image also exports them at
#                   /opt/sexton-tools for the gateway to bind-mount. The bgutil
#                   POT provider is a network service and runs here.
#   supervisord     PID 1. `autorestart=true` per program, so whisper OOMing on
#                   a long track does not take the bot out of the channel.
#
# NOT inside: a second OpenClaw gateway. That was option (a) in the issue, and
# the issue's own escape hatch applies — it doubles the gateway's config
# burden. The reasoning is written out in full in image/README.md under
# "Where the OpenClaw plugin runs"; read that before trying to move it.
#
# Build context is the REPO ROOT (bridge-proto and the workspace Cargo.toml are
# both needed):  docker build -f image/Dockerfile -t phattbeats/sexton:TAG .
# image/build.sh does this for you, on the box.

# --------------------------------------------------------------------------
# 1. The Rust build. Same toolchain and same system deps as the old
#    sexton/Dockerfile — libopus/libasound are the audio lane PHA-3342 folded
#    in, not incidental.
# --------------------------------------------------------------------------
FROM rust:1-bookworm AS rust-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config \
        libssl-dev \
        libopus-dev \
        libasound2-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY bridge-proto ./bridge-proto
COPY sexton ./sexton
RUN cargo build --release -p sexton

# --------------------------------------------------------------------------
# 2. whisper.cpp. We take the upstream image's prebuilt binaries rather than
#    compiling whisper.cpp ourselves: it is the exact artifact PHA-3228
#    verified against this server, and a from-source build would add ~10
#    minutes to every image build for a bit-identical result.
#
#    Upstream is Ubuntu 22.04 (glibc 2.35), the runtime below is Debian
#    bookworm (glibc 2.36). Older-glibc binaries run on newer glibc; the
#    reverse would not, which is why this direction is safe and why the
#    runtime stage must never become an OLDER base than bookworm.
#    `ldd whisper-server` wants: libstdc++6, libgomp1, libm, libgcc_s, plus
#    its own libwhisper/libggml*, which come along in /opt/whisper/bin.
# --------------------------------------------------------------------------
FROM ghcr.io/ggml-org/whisper.cpp:main AS whisper-src

# --------------------------------------------------------------------------
# 3. The whisper weights. A separate stage so the ~148 MB download is its own
#    cached layer and does not re-run every time a .rs file changes.
#
#    Downloaded to a temp name and moved only on success: a truncated model is
#    the failure mode where whisper-server starts, loads garbage, and reports
#    an unhelpful error at first inference instead of at boot.
# --------------------------------------------------------------------------
FROM debian:bookworm-slim AS model-fetch
ARG WHISPER_MODEL=ggml-base.en.bin
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /models \
    && curl -fL --retry 3 --retry-delay 2 \
         -o "/models/${WHISPER_MODEL}.part" \
         "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODEL}" \
    && mv "/models/${WHISPER_MODEL}.part" "/models/${WHISPER_MODEL}" \
    && ls -l /models

# --------------------------------------------------------------------------
# 4. The bgutil POT provider (PHA-3176). YouTube intermittently challenges
#    datacenter IPs, and the yt-dlp wiki's answer is a cookie file plus this
#    provider. It is a small node service; yt-dlp reaches it over HTTP, so it
#    can live in this container and still serve a yt-dlp running in the
#    gateway.
#
#    Deliberately fail-soft: if GitHub is unreachable or upstream restructures,
#    this stage writes a DISABLED marker instead of failing the build. Music
#    still works without a POT — it just gets challenged more often — and a
#    broken POT build must not cost us the bot, the bridge, and the ears.
# --------------------------------------------------------------------------
FROM node:22-bookworm-slim AS pot-builder
ARG POT_REF=master
ARG WITH_POT=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    mkdir -p /out; \
    if [ "$WITH_POT" != "1" ]; then \
      echo "disabled by --build-arg WITH_POT=$WITH_POT" > /out/DISABLED; \
    elif git clone --depth 1 --branch "$POT_REF" \
           https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /src 2>/dev/null \
         && cd /src/server \
         && npm install --no-audit --no-fund \
         && npx tsc \
         && cp -a /src/server/. /out/ \
         && [ -f /out/build/main.js ]; then \
      echo "bgutil POT provider built from $POT_REF"; \
    else \
      rm -rf /out; mkdir -p /out; \
      echo "build failed; music runs without a POT token" > /out/DISABLED; \
    fi; \
    ls -a /out | head

# --------------------------------------------------------------------------
# 5. The runtime image.
# --------------------------------------------------------------------------
FROM debian:bookworm-slim
ARG WHISPER_MODEL=ggml-base.en.bin

# ca-certificates/curl: TLS out and the healthcheck.
# libopus0/libasound2: the Sexton's audio lane (PHA-3342).
# libstdc++6/libgomp1: whisper-server's only non-bundled deps.
# ffmpeg: the music lane AND the stt-tts decode path.
# supervisor: PID 1.
# python3-minimal: the yt-dlp standalone binary bundles its own interpreter,
#   but the bgutil yt-dlp *plugin* below is plain Python and is loaded by it.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libopus0 \
        libasound2 \
        libstdc++6 \
        libgomp1 \
        ffmpeg \
        supervisor \
    && rm -rf /var/lib/apt/lists/*

# node, for the POT provider service. Copied from the pot-builder's base rather
# than apt (bookworm ships node 18; the provider wants >=20).
COPY --from=pot-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=pot-builder /usr/local/lib/node_modules /usr/local/lib/node_modules

# yt-dlp: the official standalone build. Pinned by tag so a deploy is
# reproducible; bump it deliberately when YouTube breaks it, which it will.
ARG YTDLP_VERSION=2025.09.05
RUN curl -fL --retry 3 \
      -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version

# --- the Sexton (bot + audio bridge) ---
COPY --from=rust-builder /build/target/release/sexton          /usr/local/bin/sexton
COPY --from=rust-builder /build/target/release/send-test       /usr/local/bin/send-test
COPY --from=rust-builder /build/target/release/probe-channels  /usr/local/bin/probe-channels
COPY --from=rust-builder /build/target/release/bridge-test     /usr/local/bin/bridge-test
COPY sexton/avatar/ /usr/local/share/sexton-avatar/

# --- the ears ---
COPY --from=whisper-src  /app/build/bin/                       /opt/whisper/bin/
COPY --from=model-fetch  /models/                              /opt/whisper/models/
ENV LD_LIBRARY_PATH=/opt/whisper/bin
ENV WHISPER_MODEL_PATH=/opt/whisper/models/${WHISPER_MODEL}

# --- the music lane's POT provider ---
COPY --from=pot-builder  /out/                                 /opt/bgutil-pot/

# --- the tools the gateway-side plugin has to be able to spawn ---
# See image/README.md: yt-dlp and ffmpeg are spawned by the plugin, which runs
# in the OpenClaw gateway. This directory is the export surface — bind-mount it
# into the gateway and point ytdlpPath/ffmpegPath at it, so the versions the
# plugin runs are the versions this image pinned and tested.
RUN mkdir -p /opt/sexton-tools \
    && cp /usr/local/bin/yt-dlp /opt/sexton-tools/yt-dlp \
    && cp /usr/bin/ffmpeg       /opt/sexton-tools/ffmpeg \
    && cp /usr/bin/ffprobe      /opt/sexton-tools/ffprobe

COPY image/supervisord.conf   /etc/supervisor/conf.d/sexton.conf
COPY image/run-sexton.sh      /usr/local/bin/run-sexton
COPY image/run-whisper.sh     /usr/local/bin/run-whisper
COPY image/run-pot.sh         /usr/local/bin/run-pot
COPY image/healthcheck.sh     /usr/local/bin/sexton-healthcheck
RUN chmod 0755 /usr/local/bin/run-sexton /usr/local/bin/run-whisper \
               /usr/local/bin/run-pot /usr/local/bin/sexton-healthcheck

ENV RUST_LOG=info \
    SEXTON_ADDR=teamspeak6-server \
    SEXTON_PORT=9987 \
    SEXTON_NICK=Sexton \
    SEXTON_CHANNEL="General Shit" \
    SEXTON_LOG_DIR=/var/sexton-logs \
    SEXTON_AVATAR=/usr/local/share/sexton-avatar/brandon.png \
    SEXTON_IDENTITY_FILE=/config/sexton-id.txt \
    WHISPER_PORT=8080 \
    WHISPER_THREADS=4 \
    WHISPER_LANGUAGE=en \
    POT_PORT=4416 \
    POT_HOST=0.0.0.0

# 9099 the bridge WebSocket (the plugin dials this), 8080 whisper, 4416 POT.
# None of the three should ever be published to the host: the whole premise of
# the STT lane is that the channel's audio does not leave the box, and a
# published port is the easiest way to lose that by accident. Reach them by
# container name on the `phattvip` network.
EXPOSE 9099 8080 4416

VOLUME ["/var/sexton-logs", "/config"]

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=90s \
    CMD /usr/local/bin/sexton-healthcheck

ENTRYPOINT ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/sexton.conf"]
