# PHA-3174: phattbeats/ts-bridge — audio sidecar for the Sexton.
# Runs on the TS6 host's Docker network (`phattvip`), connects to the TS6
# server by container name (not teamspeak.phatt.vip — see PHA-3172 finding #5).

FROM rust:1-bookworm AS build
RUN apt-get update -qq && apt-get install -yq --no-install-recommends \
    pkg-config libopus-dev libasound2-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update -qq && apt-get install -yq --no-install-recommends \
    libopus0 libasound2 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/ts-bridge /usr/local/bin/ts-bridge
COPY --from=build /src/target/release/bridge-test /usr/local/bin/bridge-test

# Local-only WebSocket — never publish this port outside the compose network.
EXPOSE 9099

ENV TS_SERVER_ADDRESS=teamspeak6-server:9987 \
    TS_NICKNAME=Sexton-Bridge \
    TS_CHANNEL="" \
    WS_BIND=0.0.0.0:9099 \
    DUCK_GAIN=0.25 \
    RUST_LOG=info

ENTRYPOINT ["/usr/local/bin/ts-bridge"]
