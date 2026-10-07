# #3791: every TeamSpeak bot, and everything they lean on, as ONE image
# and ONE container (teamspeak-universal-bot). Brandon, 2026-10-02/03: "since
# openclaw can handle multiple agents, cant they all be under one, expanding
# container?" ... "combine everything into one". So one gateway runs one agent
# + one teamspeak account per persona pack, each bot keeps its own Rust core
# (its own TeamSpeak identity), and the old sidecars are programs in here:
# the whisper pool + coalescing proxy, the POT provider, suno-api and
# ts-summoner. image/universal/ holds the per-bot wiring (stack.mjs).
#
# #3428 (the history below still holds for each piece): the whole Sexton
# stack as ONE image.
#
# Brandon's decision 2026-09-12: one image, one container, one Unraid template
# entry. Everything the Sexton needs to keep the hall — text, voice, ears, and
# music — lives in here, supervised, and comes back on its own when one piece
# dies.
#
# What is inside, and why each piece is here rather than beside it:
#
#   sexton          The bot. Since #3342 this one binary is also the audio
#                   bridge #3174 used to run as `ts-bridge`: one tsclientlib
#                   connection, one bot account, and the bridge WebSocket on
#                   :9099 that the OpenClaw teamspeak plugin dials.
#   whisper-server  whisper.cpp's HTTP server plus `ggml-base.en.bin`, BAKED IN
#                   (#3228). Formerly the `whisper` sidecar container. The
#                   weights are ~148 MB and they are the single reason the STT
#                   lane costs $0 and never leaves the box, so they ship with
#                   the image rather than being fetched on first boot into a
#                   host directory somebody can forget to back up.
#   ffmpeg, yt-dlp  The #3176 music lane, plus the ffmpeg the stt-tts lane
#   + POT provider  decodes TTS with. The plugin spawns ffmpeg and yt-dlp as
#                   child processes, and under option (a) the plugin runs in
#                   THIS container, so they are simply on PATH here. No export
#                   directory, no bind-mount into another container.
#   openclaw        A gateway of its own, running the `teamspeak` channel
#   + the plugin    plugin, installed by the #3326 `--link` path at boot.
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
# needs its own config, state dir and model credentials, and #3326's finding
# stands — a core bump does not update a managed channel plugin, so both
# gateways need checking after an upgrade. image/deploy.sh pays most of that
# once, by importing the model/auth blocks from the main gateway rather than
# asking anyone to retype them.
#
# Build context is the REPO ROOT (bridge-proto and the workspace Cargo.toml are
# both needed):  docker build -f image/Dockerfile -t phattbeats/teamspeak-universal-bot:TAG .
# image/build.sh does this for you, on the box.

# The gateway version, used by TWO `FROM` lines (the plugin builder and the
# runtime). It has to be declared up here, before the first FROM, to be global
# — an ARG written between stages belongs to the stage above it and would not
# resolve in a later FROM, which fails as a silent `:` tag rather than an error.
# Keep it equal to the main gateway: docker exec OpenClaw openclaw --version.
ARG OPENCLAW_VERSION=2026.9.3

# --------------------------------------------------------------------------
# 1. The Rust build. Same toolchain and same system deps as the old
#    sexton/Dockerfile — libopus/libasound are the audio lane #3342 folded
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
#    compiling whisper.cpp ourselves: it is the exact artifact #3228
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
#    #3554: NOT `ghcr.io/ggml-org/whisper.cpp:main` any more. That tag
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
    && curl -fL --retry 3 --retry-delay 2 \
         -o /models/ggml-silero-v5.1.2.bin.part \
         "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin" \
    && mv /models/ggml-silero-v5.1.2.bin.part /models/ggml-silero-v5.1.2.bin \
    && ls -l /models

# --------------------------------------------------------------------------
# 4. The bgutil POT provider (#3176). YouTube intermittently challenges
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
#    The plugin ships TypeScript and no compiled dist/, deliberately: #3326
#    found that `openclaw plugins install --link` is the one install form
#    exempt from the built-runtime-entry check, and that `git:` installs fail
#    on this plugin outright. So there is no build step here — only its runtime
#    dependency (`ws`), installed with the gateway image's own node/npm so the
#    resolved tree is the one that gateway will actually load.
#
#    #3580: the source is teamspeak-plugin/ in THIS repo, not a staged copy
#    of a separate `openclaw-teamspeak-plugin` repo — that split (#3220)
#    existed to let the plugin and the chat logger ship on independent
#    cadences, a reason that evaporated once #3341/3342 folded them onto
#    one tsclientlib connection and #3428 put them in one image. One git
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
# 5b. suno-api (#3554), Bexton's band generator. Upstream gcui-art/suno-api
#     at the commit it stalled on, plus our patches (image/suno-api/
#     phattbeats.patch: the 2026 Suno UI, Turnstile through 2Captcha, the
#     v2-web generate path, the proxy, the decrypted-audio route). Built on the
#     gateway image so its native modules match the node that runs it.
#     Chromium comes the two ways the old image had it: the
#     @playwright/browser-chromium postinstall and `playwright install`.
#     --include=dev: the gateway image sets NODE_ENV=production, and the
#     build needs tailwind and typescript.
# --------------------------------------------------------------------------
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION} AS suno-builder
USER root
ARG SUNO_API_REF=a2e6a823428903af715d3835d1cb44ffa336021d
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates patch \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/suno-api
COPY image/suno-api/phattbeats.patch /tmp/phattbeats.patch
RUN git init -q . \
    && git fetch -q --depth 1 https://github.com/gcui-art/suno-api.git "$SUNO_API_REF" \
    && git checkout -q FETCH_HEAD \
    && git apply /tmp/phattbeats.patch \
    && rm -rf .git \
    && npm install --include=dev --no-audit --no-fund \
    && npm run build \
    && npm prune --omit=dev --no-audit --no-fund \
    && npx -y playwright install chromium \
    && rm -rf public && ln -s /config/suno-api/public public \
    && test -d .next && ls /opt/ms-playwright

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
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION} AS runtime
ARG WHISPER_MODEL=ggml-base.en.bin

# The gateway image declares USER node. Everything here needs root: apt, the
# supervisord that is PID 1 (its conf says user=root and its socket lives in
# /run), the bot writing its identity to the mounted /config, and whisper
# reading /opt. This is also what the `OpenClaw` container on the box already
# does — Unraid overrides that image's user to root — so running as root here
# is matching the deployed gateway, not loosening it.
USER root

# ca-certificates/curl: TLS out and the healthcheck.
# libopus0/libasound2: the Sexton's audio lane (#3342).
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
        openssh-client \
        sshpass \
        tzdata \
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
# #3791: the default avatar used to live here (sexton/avatar/brandon.png,
# an existing inconsistency with bexton whose avatar lived under image/).
# It is now personas/sexton/avatar.png, copied below with the rest of the
# persona pack — see the persona COPY block.

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

# --- #3791: the shared whisper pool (was the `whisper` container) ---
COPY whisper/run-whisper-pool.sh                               /usr/local/bin/run-whisper-pool
COPY whisper/coalescing-proxy.mjs                              /opt/whisper/coalescing-proxy.mjs

# --- #3791: suno-api (was the `suno-api` container) + its chromium ---
COPY --from=suno-builder /opt/suno-api/                        /opt/suno-api/
COPY --from=suno-builder /opt/ms-playwright/                   /opt/ms-playwright/
RUN cd /opt/suno-api \
    && PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx -y playwright install-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# --- #3791: ts-summoner (was the `ts-summoner` container) ---
COPY ts-summoner/summoner.mjs ts-summoner/schedule.mjs ts-summoner/story.mjs \
     ts-summoner/variety.mjs ts-summoner/guests.mjs ts-summoner/banter.mjs \
     ts-summoner/insights.mjs ts-summoner/insights-stats.mjs ts-summoner/insights-web.mjs \
     ts-summoner/config.json                                   /opt/ts-summoner/
COPY ts-summoner/insights/                                     /opt/ts-summoner/insights/
COPY ts-summoner/live/                                         /opt/ts-summoner/live/

# --- the gateway's channel plugin ---
# Baked in, but NOT installed at build time: `openclaw plugins install --link`
# writes its install record into the gateway's state dir, which is a mounted
# volume and therefore empty at build time and persistent at runtime. So the
# link install happens in run-gateway, on every boot, idempotently — which is
# also what makes it survive an image bump without a manual reinstall.
COPY --from=plugin-builder /plugin/ /opt/openclaw-teamspeak-plugin/

# #3829: two narrow OpenClaw core patches for TeamSpeak turns, both caused
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

COPY image/gateway/openclaw.seed.json /opt/sexton-gateway/openclaw.seed.json
# #3791: the persona packs, whole. Each personas/<id>/ is one bot: its
# workspace markdown, voice.json/tools.json (account seed), lines/moods and
# avatar. stack.mjs reads them in place; /config/personas/<id>/ adds or
# overrides a pack without a rebuild. HUMAN.md is the shared tone for all.
COPY personas/                        /opt/personas/
COPY image/lexton/lexton-menace.cjs   /opt/sexton-menace/lexton-menace.cjs
COPY image/universal/stack.mjs image/universal/env-exec.mjs image/universal/migrate.mjs /opt/universal/
COPY image/universal/supervisord.conf /etc/supervisor/universal.conf
COPY image/universal/run-universal.sh /usr/local/bin/run-universal
COPY image/universal/run-summoner.sh  /usr/local/bin/run-summoner
COPY image/universal/run-insights.sh  /usr/local/bin/run-insights
COPY image/universal/run-suno-api.sh  /usr/local/bin/run-suno-api
COPY image/universal/healthcheck.sh   /usr/local/bin/universal-healthcheck
COPY image/run-sexton.sh             /usr/local/bin/run-sexton
COPY image/run-pot.sh                /usr/local/bin/run-pot
COPY image/run-gateway.sh            /usr/local/bin/run-gateway
COPY image/run-menace.sh             /usr/local/bin/run-menace
RUN chmod 0755 /usr/local/bin/run-sexton /usr/local/bin/run-whisper-pool \
               /usr/local/bin/run-pot /usr/local/bin/run-gateway \
               /usr/local/bin/run-menace /usr/local/bin/run-universal \
               /usr/local/bin/run-summoner /usr/local/bin/run-suno-api \
               /usr/local/bin/run-insights \
               /usr/local/bin/universal-healthcheck

ENV RUST_LOG=info \
    SEXTON_ADDR=teamspeak6-server \
    SEXTON_PORT=9987 \
    SEXTON_CHANNEL="General Shit" \
    SEXTON_LOG_DIR=/var/sexton-logs \
    WHISPER_WORKERS=2 \
    WHISPER_THREADS=3 \
    WHISPER_LANGUAGE=en \
    POT_PORT=4416 \
    POT_HOST=127.0.0.1 \
    OPENCLAW_STATE_DIR=/config/openclaw \
    OPENCLAW_CONFIG_PATH=/config/openclaw/openclaw.json \
    SEXTON_GATEWAY_PORT=18789 \
    SEXTON_GATEWAY_BIND=lan \
    SEXTON_PLUGIN_DIR=/opt/openclaw-teamspeak-plugin \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    TZ=America/New_York

# Every service in the container talks to the others over loopback: bridges
# 9101+, whisper 8080-8082, POT 4416, suno-api 3000, summoner 8099. 18789 is
# the gateway's own control port. 8097 is the insights dashboard (#3963),
# the one port deploy.sh publishes; it sits behind basic auth.
EXPOSE 18789 8097

# /config: bots.json, per-bot identities and state (bots/<id>/), the gateway's
# config+state (openclaw/), the summoner's editable files (summoner/), and
# suno-api.env. /var/sexton-logs: each core's room log, by bot.
VOLUME ["/var/sexton-logs", "/config"]

HEALTHCHECK --interval=30s --timeout=15s --retries=3 --start-period=120s \
    CMD /usr/local/bin/universal-healthcheck

ENTRYPOINT ["/usr/local/bin/run-universal"]
