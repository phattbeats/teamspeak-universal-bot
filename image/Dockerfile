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
#   + POT provider  decodes TTS with. The plugin spawns ffmpeg and yt-dlp as
#                   child processes, and under option (a) the plugin runs in
#                   THIS container, so they are simply on PATH here. No export
#                   directory, no bind-mount into another container.
#   openclaw        A gateway of its own, running the `teamspeak` channel
#   + the plugin    plugin, installed by the PHA-3326 `--link` path at boot.
#                   This is option (a), per Brandon 2026-09-12. See the note
#                   below and image/README.md.
#   supervisord     PID 1. `autorestart=true` per program, so whisper OOMing on
#                   a long track does not take the bot out of the channel.
#
# On option (a). The issue offered an escape hatch — prefer (a) "unless it
# doubles the gateway's config burden" — and an earlier revision of this file
# took it and shipped (b). Brandon overruled that on 2026-09-12: option (a),
# and do not wire the bridge socket out to the main gateway. So the gateway
# lives here now. What that buys, concretely:
#
#   * The bridge WebSocket, whisper and the POT provider stop being a network
#     surface at all — the only thing that dials them is a process in this
#     container, over loopback. Under (b) they had to listen on 0.0.0.0 for a
#     peer on `phattvip`.
#   * ffmpeg/yt-dlp stop needing the /opt/sexton-tools export and the two
#     read-only path mappings on the OpenClaw container that (b) required a
#     human to add in the Unraid GUI. That was the last manual step in this
#     issue and it is now gone.
#   * The main gateway's teamspeak channel must be DISABLED at cutover. Two
#     gateways on one bridge socket is two answers to every message.
#
# The cost (b) was written to avoid is real and unchanged: a second gateway
# needs its own config, state dir and model credentials, and PHA-3326's finding
# stands — a core bump does not update a managed channel plugin, so both
# gateways need checking after an upgrade. image/deploy.sh pays most of that
# once, by importing the model/auth blocks from the main gateway rather than
# asking anyone to retype them.
#
# Build context is the REPO ROOT (bridge-proto and the workspace Cargo.toml are
# both needed):  docker build -f image/Dockerfile -t phattbeats/sexton:TAG .
# image/build.sh does this for you, on the box.

# The gateway version, used by TWO `FROM` lines (the plugin builder and the
# runtime). It has to be declared up here, before the first FROM, to be global
# — an ARG written between stages belongs to the stage above it and would not
# resolve in a later FROM, which fails as a silent `:` tag rather than an error.
# Keep it equal to the main gateway: docker exec OpenClaw openclaw --version.
ARG OPENCLAW_VERSION=2026.9.3

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
#
#    PHA-3554: NOT `ghcr.io/ggml-org/whisper.cpp:main` any more. That tag
#    moves, and the 2026-09-17 build of it (ggml 0.24, parakeet) dies with
#    SIGILL on PHATT-RAID's Ryzen 2600X the moment it runs inference — a
#    binary built for instructions this CPU does not have. `--help` still
#    works, so the image verification was green while the STT lane was dead
#    in the room. Building from a pinned release with GGML_NATIVE=OFF and an
#    explicit AVX2 feature set is what makes the result depend on this
#    Dockerfile rather than on what upstream's runner happened to be.
#    Static, so nothing depends on which .so files a given release lays out.
FROM debian:bookworm-slim AS whisper-src
ARG WHISPER_CPP_VERSION=v1.9.3
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN git clone --depth 1 --branch "${WHISPER_CPP_VERSION}" https://github.com/ggml-org/whisper.cpp.git . \
    && cmake -B build \
         -DCMAKE_BUILD_TYPE=Release \
         -DBUILD_SHARED_LIBS=OFF \
         -DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON \
         -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_SERVER=ON \
    && cmake --build build --config Release -j"$(nproc)" --target whisper-server whisper-cli \
    && ls -l build/bin/whisper-server build/bin/whisper-cli

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
         && cp -a /src/plugin /out/ytdlp-plugin \
         && [ -f /out/build/main.js ]; then \
      echo "bgutil POT provider built from $POT_REF"; \
    else \
      rm -rf /out; mkdir -p /out; \
      echo "build failed; music runs without a POT token" > /out/DISABLED; \
    fi; \
    ls -a /out | head

# --------------------------------------------------------------------------
# 5. The OpenClaw teamspeak channel plugin (option (a)).
#
#    The plugin ships TypeScript and no compiled dist/, deliberately: PHA-3326
#    found that `openclaw plugins install --link` is the one install form
#    exempt from the built-runtime-entry check, and that `git:` installs fail
#    on this plugin outright. So there is no build step here — only its runtime
#    dependency (`ws`), installed with the gateway image's own node/npm so the
#    resolved tree is the one that gateway will actually load.
#
#    PHA-3580: the source is teamspeak-plugin/ in THIS repo, not a staged copy
#    of a separate `openclaw-teamspeak-plugin` repo — that split (PHA-3220)
#    existed to let the plugin and the chat logger ship on independent
#    cadences, a reason that evaporated once PHA-3341/3342 folded them onto
#    one tsclientlib connection and PHA-3428 put them in one image. One git
#    tree, one PR, one CI run.
#
#    The standalone-only scaffolding (SDK stubs, the standalone vitest config)
#    is stripped by .dockerignore rather than by a build step: the SDK stubs
#    exist so the plugin can be tested outside a gateway, and in a runtime
#    install they would shadow the real thing.
# --------------------------------------------------------------------------
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION} AS plugin-builder
# The gateway image does not run as root, and COPY lands files owned by root,
# so an unprivileged npm cannot write node_modules into /plugin. This is a
# throwaway builder stage — nothing from it ships except the directory itself —
# so root here costs nothing. The runtime stage keeps the base image's user.
USER root
WORKDIR /plugin
COPY teamspeak-plugin/ /plugin/
RUN npm install --omit=dev --no-audit --no-fund \
    && test -f /plugin/openclaw.plugin.json \
    && test -f /plugin/index.ts \
    && test -d /plugin/node_modules/ws

# --------------------------------------------------------------------------
# 6. The runtime image.
#
#    The base is the stock OpenClaw gateway image, NOT debian:bookworm-slim.
#    Option (a) needs a gateway in here, and taking it from upstream's own
#    image is the only way to be certain this gateway is bit-identical to the
#    one on the box — an `npm i -g openclaw` would drift the moment upstream
#    republishes, and the whole point of pinning OPENCLAW_VERSION is that the
#    two gateways stay on one version.
#
#    It is Debian bookworm, glibc 2.36 — the same base the runtime used to be,
#    which is what keeps the whisper.cpp binaries (built against glibc 2.35 on
#    Ubuntu 22.04) loadable. If upstream ever rebases onto something OLDER than
#    bookworm, stage 2's note applies and this breaks; check `ldd --version`
#    before bumping OPENCLAW_VERSION across a base change.
#
#    It also already carries node 24, so the POT provider no longer needs node
#    copied in from its builder stage.
# --------------------------------------------------------------------------
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}
ARG WHISPER_MODEL=ggml-base.en.bin

# The gateway image declares USER node. Everything here needs root: apt, the
# supervisord that is PID 1 (its conf says user=root and its socket lives in
# /run), the bot writing its identity to the mounted /config, and whisper
# reading /opt. This is also what the `OpenClaw` container on the box already
# does — Unraid overrides that image's user to root — so running as root here
# is matching the deployed gateway, not loosening it.
USER root

# ca-certificates/curl: TLS out and the healthcheck.
# libopus0/libasound2: the Sexton's audio lane (PHA-3342).
# libstdc++6/libgomp1: whisper-server's only non-bundled deps.
# ffmpeg: the music lane AND the stt-tts decode path. The gateway image has
#   neither ffmpeg nor yt-dlp — checked, `which` returns nothing in it — which
#   is why the music lane and the TTS decode path never actually worked under
#   (b). Installing them here fixes that as a side effect of option (a).
# supervisor: PID 1.
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

# yt-dlp: the official standalone build. Pinned by tag so a deploy is
# reproducible; bump it deliberately when YouTube breaks it, which it will.
ARG YTDLP_VERSION=2026.08.19
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

# The yt-dlp SIDE of the POT provider. The server above is only half of it:
# without this plugin, `yt-dlp --verbose` reports "PO Token Providers: none" and
# quietly never contacts the server at all — a running service and a feature
# that does nothing, which is exactly what the first verification run found.
#
# The path shape is load-bearing and is NOT the one the repo ships. yt-dlp wants
#   /etc/yt-dlp/plugins/<package>/yt_dlp_plugins/extractor/*.py
# — note the <package> level. Dropping `yt_dlp_plugins` straight into
# /etc/yt-dlp/plugins leaves it invisible ("Plugin directories: none"), and
# `--plugin-dirs` does not rescue it: neither the parent-of-yt_dlp_plugins form
# nor pointing at yt_dlp_plugins itself registers anything on this build. Verified
# working here as `PO Token Providers: bgutil:http-2.0.0 (external)`.
#
# `|| true`: the POT stage is allowed to fail (see stage 4), and if it did there
# is no plugin to install and music still works without a token.
RUN mkdir -p /etc/yt-dlp/plugins/bgutil \
    && cp -a /opt/bgutil-pot/ytdlp-plugin/yt_dlp_plugins /etc/yt-dlp/plugins/bgutil/ 2>/dev/null || true

# --- the gateway's channel plugin ---
# Baked in, but NOT installed at build time: `openclaw plugins install --link`
# writes its install record into the gateway's state dir, which is a mounted
# volume and therefore empty at build time and persistent at runtime. So the
# link install happens in run-gateway, on every boot, idempotently — which is
# also what makes it survive an image bump without a manual reinstall.
COPY --from=plugin-builder /plugin/ /opt/openclaw-teamspeak-plugin/

# PHA-3829: two narrow OpenClaw core patches for TeamSpeak turns, both caused
# by the voice lane marking its turns ChatType "direct":
#  - a "Conversation info" block wrapped in <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>
#    rode after every line, and the bots took it for something the speaker
#    pasted. Dropped; the line already says who spoke.
#  - "direct" forbids silent replies, so every NO_REPLY got re-run until the bot
#    said something. TeamSpeak turns get the group rule for that one decision.
# No config switch covers either. The script fails the build if an
# OPENCLAW_VERSION bump moves the code it patches.
COPY image/gateway/patch-openclaw-teamspeak.mjs /tmp/patch-openclaw-teamspeak.mjs
RUN node /tmp/patch-openclaw-teamspeak.mjs /app/dist \
    && rm /tmp/patch-openclaw-teamspeak.mjs

COPY image/supervisord.conf          /etc/supervisor/conf.d/sexton.conf
COPY image/gateway/openclaw.seed.json /opt/sexton-gateway/openclaw.seed.json
# PHA-3787: the Sexton's own persona, seeded the same way Bexton's already was
# — this is the fix for "Sexton has no persona," see image/sexton/workspace.
COPY image/sexton/workspace/           /opt/sexton-persona/sexton/
# PHA-3554: the Bexton persona, seeded into the gateway workspace on first boot
# when SEXTON_AGENT_ID=bexton. Same image, different agent in the chair.
COPY image/bexton/workspace/           /opt/sexton-persona/bexton/
COPY image/bexton/avatar/bexton.png    /usr/local/share/sexton-avatar/bexton.png
# PHA-3787: HUMAN.md is shared by every persona — copied into both persona
# directories from one source so there is exactly one copy to edit.
COPY image/workspace-common/HUMAN.md   /opt/sexton-persona/sexton/HUMAN.md
COPY image/workspace-common/HUMAN.md   /opt/sexton-persona/bexton/HUMAN.md
COPY image/run-sexton.sh             /usr/local/bin/run-sexton
COPY image/run-whisper.sh            /usr/local/bin/run-whisper
COPY image/run-pot.sh                /usr/local/bin/run-pot
COPY image/run-gateway.sh            /usr/local/bin/run-gateway
COPY image/healthcheck.sh            /usr/local/bin/sexton-healthcheck
RUN chmod 0755 /usr/local/bin/run-sexton /usr/local/bin/run-whisper \
               /usr/local/bin/run-pot /usr/local/bin/run-gateway \
               /usr/local/bin/sexton-healthcheck

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
    POT_HOST=0.0.0.0 \
    OPENCLAW_STATE_DIR=/config/openclaw \
    OPENCLAW_CONFIG_PATH=/config/openclaw/openclaw.json \
    SEXTON_GATEWAY_PORT=18789 \
    SEXTON_GATEWAY_BIND=lan \
    SEXTON_PLUGIN_DIR=/opt/openclaw-teamspeak-plugin

# 9099 the bridge WebSocket, 8080 whisper, 4416 POT, 18789 the gateway.
# None of them should ever be published to the host. Under option (a) the only
# client of the first three is the gateway in this same container, over
# loopback — the whole premise of the local STT lane is that the channel's
# audio does not leave the box, and a published port is the easiest way to lose
# that by accident. 18789 is the gateway's own control port; publish it only if
# you actually want a second Control UI, and put auth on it if you do.
EXPOSE 9099 8080 4416 18789

# /config now holds two things: the bot's TeamSpeak identity (sexton-id.txt)
# and the gateway's whole config+state tree (openclaw/). Both are the kind of
# state that is painful to lose — the identity IS the bot's server-side UID,
# and openclaw/ carries the plugin install record and the channel config.
VOLUME ["/var/sexton-logs", "/config"]

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=90s \
    CMD /usr/local/bin/sexton-healthcheck

ENTRYPOINT ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/sexton.conf"]
