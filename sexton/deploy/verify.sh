#!/bin/bash
# PHA-3107 / PHA-3173 verification recipe, run on PHATT-RAID.
#   three messages from two accounts, with a mute and a channel hop in between
#   -> joiner gets one PM, log has three lines, channel description is
#      untouched and no channel-edit notification sound fires (PHA-3424)
#
# Account A stays connected for the whole run and sends messages one and three;
# account B joins in the middle and sends message two. A mutes/unmutes between
# one and two; B hops to a temporary channel and back between two and three.
set -u
IMG=phattbeats/sexton:dev
NET=phattvip
CH="General Shit"
LOGDIR=/mnt/user/appdata/sexton/logs
IDENT=$(cat /mnt/user/scratch/sexton/sexton-id.txt)
STRIP="Solve RSA puzzle|Unknown argument|tsclientlib version|Resender: Changed|tsproto_version"

run_test() {  # nickname, script, linger
  docker run --rm --network $NET -e RUST_LOG=info --entrypoint /usr/local/bin/send-test "$IMG" \
    -a teamspeak6-server:9987 -n "$1" -c "$CH" -s "$2" --linger-seconds "${3:-0}" 2>&1 \
    | grep -vE "$STRIP" | sed "s/^/[$1] /"
}

echo "################ 0. fresh Sexton from $IMG (2 humans already on the server)"
rm -rf "$LOGDIR"; mkdir -p "$LOGDIR"
docker rm -f sexton >/dev/null 2>&1
docker run -d --name sexton --network $NET --restart unless-stopped -e RUST_LOG=info \
  -v "$LOGDIR":/var/sexton-logs "$IMG" \
  -a teamspeak6-server -p 9987 -n Sexton -c "$CH" \
  -i "$IDENT" -A /usr/local/share/sexton-avatar/brandon.png -l /var/sexton-logs >/dev/null
sleep 14
docker logs sexton 2>&1 | grep -vE "$STRIP"

echo
echo "################ 1-3. A: one, MUTE/UNMUTE ... B joins: two, HOP ... A: three"
run_test SextonTestA "say:one — from A before the mute,mute,unmute,wait:12000,say:three — from A after the hop" 4 &
A_PID=$!
sleep 7
run_test SextonTestB "say:two — from B after the mute,hop,back" 6
wait $A_PID

sleep 3
echo
echo "################ 4. Sexton log"
docker logs sexton 2>&1 | grep -vE "$STRIP"

echo
echo "################ 5. on-disk markdown log"
find "$LOGDIR" -type f -print -exec cat {} \;
