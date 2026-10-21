#!/bin/sh
# #3791: health of the one container. Unhealthy means the gateway is down,
# because that is the one thing every bot shares. A stopped core is normal (off
# shift, ts-summoner's call) and is only reported, as are the shared services.
set -u
: "${SEXTON_GATEWAY_PORT:=18789}"
: "${UNIVERSAL_VOICE:=1}"
: "${UNIVERSAL_VOICE_OFF_FILE:=/config/.voice-off}"

listening() { # port: any HTTP answer counts; curl rc 7/28 = nothing there
  curl -sS -m 5 -o /dev/null "http://127.0.0.1:$1/" 2>/dev/null
  rc=$?
  [ "$rc" != 7 ] && [ "$rc" != 28 ]
}

fail=0
if listening "$SEXTON_GATEWAY_PORT"; then echo "gateway: ready"; else echo "unhealthy: gateway not listening on :$SEXTON_GATEWAY_PORT"; fail=1; fi
# #4372: with voice off there is no whisper by design, and that is healthy.
case "$(printf '%s' "$UNIVERSAL_VOICE" | tr '[:upper:]' '[:lower:]')" in 0 | false | no | off) voice_off=1 ;; *) voice_off=0 ;; esac
[ -e "$UNIVERSAL_VOICE_OFF_FILE" ] && voice_off=1
if [ "$voice_off" = 1 ]; then
  echo "whisper: off (voice off)"
else
  listening 8082 && echo "whisper: ready" || echo "whisper: not ready (not fatal)"
fi
supervisorctl status 2>/dev/null | awk '{print "  " $1 ": " $2}'
exit "$fail"
