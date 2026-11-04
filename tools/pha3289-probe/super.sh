#!/bin/sh
cd /mnt/user/appdata/sexton-build/pha3289-probe
BIG="id=9999 clid=9999 reason=1 type=1 name=probe codec=1 properties=x width=1280 height=720 framerate=15 fps=15 bitrate=1000 max_width=1280 max_height=720 max_framerate=15 max_bitrate=1000 resolution=720 quality=1 mode=1 audio=0 has_audio=0 sound=0 cid=1 channel=1 target=9999 targetid=9999 tclid=9999 accept=0 accepted=0 decision=0 allow=0 result=0 response=0 answer=x offer=x sdp=x candidate=x ice=x data=x payload=x signal=x signaling=x json=x msg=x message=x text=x value=x key=x token=x password=x pw=x viewer=9999 viewers=9999 invokerid=9999 private=0 public=1 permission=0 encrypted=0 description=x desc=x title=x topic=x"
LOG=$1; shift
A=""
for c in "$@"; do A="$A --cmd \"$c $BIG\""; done
eval sh run.sh $LOG --reply-timeout 4 --listen-seconds 2 $A >/dev/null
sed "s/\x1b\[[0-9;]*m//g" $LOG | grep -E "content=" | grep -v "channellist\|grouplist\|neededperm\|cliententerview\|initserver\|initivexpand\|channelsubscribed\|clientinit\|clientek\|connectioninfo\|notifyconnection" | sed "s/.*content=//" | sed "s/ id=9999 clid=9999.*return_code/ ...BIG... return_code/" | cut -c1-500
