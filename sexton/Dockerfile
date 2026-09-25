# Multi-stage build: compile the Sexton (and its verification helpers) with
# a full Rust toolchain, ship only the runtime binaries.
#
# PHA-3342: the Sexton now depends on `bridge-proto` via a workspace path
# dependency (`../bridge-proto`), and links against libopus/libasound for
# the audio lane the old `ts-bridge` container used to own. Both mean the
# build context can no longer be `sexton/` alone (as it was pre-PHA-3342) —
# it has to be the repo root, so `bridge-proto` and the workspace
# `Cargo.toml` (which `bridge-proto/Cargo.toml` inherits `edition`/
# `license`/`publish` from via `.workspace = true`) are both present. See
# `deploy/sexton-compose.yml`'s `build:` stanza for the context/dockerfile
# split this requires.
FROM rust:1-bookworm AS builder
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

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libopus0 \
        libasound2 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/target/release/sexton /usr/local/bin/sexton
COPY --from=builder /build/target/release/send-test /usr/local/bin/send-test
COPY --from=builder /build/target/release/probe-channels /usr/local/bin/probe-channels
COPY --from=builder /build/target/release/bridge-test /usr/local/bin/bridge-test
COPY sexton/avatar/ /usr/local/share/sexton-avatar/
COPY sexton/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh
ENV RUST_LOG=info
# PHA-3798: this image is published standalone as ghcr.io/phattbeats/plnt-ts-bridge
# for a bring-your-own-OpenClaw deploy (someone else's gateway, this
# container is just the TeamSpeak client half). /data is where the pinned
# TS identity and the chat-history logs live; back it up or lose the bot's
# TeamSpeak UID on the next recreate.
VOLUME ["/data"]
# The audio/voice bridge WebSocket (PROTOCOL.md) — local-only, never publish
# this port outside the compose network (formerly ts-bridge's EXPOSE).
EXPOSE 9099
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
