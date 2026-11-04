#!/bin/sh
# usage: run.sh <logname> [probe args...]
D=/mnt/user/appdata/sexton-build/pha3289-probe
LOG=$1; shift
docker run --rm --network phattvip -v $D/src/target/release/stream-probe:/probe:ro -e RUST_LOG=tsproto=debug,tsclientlib=debug rust:1-bookworm sh -c 'apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends libopus0 >/dev/null 2>&1; exec /probe "$@"' probe "$@" > $D/$LOG 2>&1
echo exit=$?
