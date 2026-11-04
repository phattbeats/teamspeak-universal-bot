#!/bin/sh
# usage: sweep.sh <cmd> <base-params>  -> tries base + each candidate key
cd /mnt/user/appdata/sexton-build/pha3289-probe
C=$1; B=$2
A=""
for k in reason reasonmsg reasonid password pw cid channel_id ctid target targetid tclid client_id invokerid viewer clid accept decision result response offer answer candidate sdp sdpmid mid kind data json payload msg message text value key properties token; do
  A="$A --cmd \"$C $B $k=1\""
done
eval sh run.sh sweep-$C.log --reply-timeout 2 --listen-seconds 1 $A >/dev/null
sed "s/\x1b\[[0-9;]*m//g" sweep-$C.log | grep -E "content=" | grep -E "dir=OUT.*$C|error id|notify" | grep -v "channellist\|grouplist\|neededperm\|cliententerview\|initserver\|initivexpand\|channelsubscribed\|clientinit" | sed "s/.*content=//" | paste - - | grep -v "id=1542" 
echo "== $C done"
