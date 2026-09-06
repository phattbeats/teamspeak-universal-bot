# Multi-stage build: compile the Sexton (and its verification helpers) with
# a full Rust toolchain, ship only the runtime binaries.
FROM rust:1-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config \
        libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/target/release/sexton /usr/local/bin/sexton
COPY --from=builder /build/target/release/send-test /usr/local/bin/send-test
COPY --from=builder /build/target/release/probe-channels /usr/local/bin/probe-channels
COPY avatar/ /usr/local/share/sexton-avatar/
COPY on-connected.sh /usr/local/bin/on-connected
RUN chmod +x /usr/local/bin/on-connected
ENV RUST_LOG=info
ENTRYPOINT ["/usr/local/bin/sexton"]
