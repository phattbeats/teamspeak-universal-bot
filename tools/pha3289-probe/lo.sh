#!/bin/sh
# leave-one-out: lo.sh <cmd> <tag> <keys...>
cd /mnt/user/appdata/sexton-build/pha3289-probe
BIG="id=9999 clid=9999 reason=1 type=1 name=probe codec=1 properties=x width=1280 height=720 framerate=15 fps=15 bitrate=1000 max_width=1280 max_height=720 max_framerate=15 max_bitrate=1000 resolution=720 quality=1 mode=1 audio=0 has_audio=0 sound=0 cid=1 channel=1 target=9999 targetid=9999 tclid=9999 accept=0 accepted=0 decision=0 allow=0 result=0 response=0 answer=x offer=x sdp=x candidate=x ice=x data=x payload=x signal=x signaling=x json=x msg=x message=x text=x value=x key=x token=x password=x pw=x viewer=9999 viewers=9999 invokerid=9999 private=0 public=1 permission=0 encrypted=0 description=x desc=x title=x topic=x"
C=$1; T=$2; shift 2
A=""
for k in "$@"; do
  P=$(echo " $BIG" | sed "s/ $k=[^ ]*//")
  A="$A --cmd \"$C$P\""
done
eval sh run.sh lo-$C-$T.log --reply-timeout 3 --listen-seconds 1 $A >/dev/null
i=0
for k in "$@"; do
  r=$(sed "s/\x1b\[[0-9;]*m//g" lo-$C-$T.log | grep "content=\"error id=[0-9]* .*return_code=$i\"" | sed "s/.*content=\"error id=\([0-9]*\) msg=\([^ ]*\).*/\1 \2/")
  echo "$C -$k => $r"
  i=$((i+1))
done
