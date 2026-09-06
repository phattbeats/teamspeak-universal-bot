#!/bin/sh
# Posted via --on-connected when the bot successfully connects.
# Posts a comment to PHA-3099 with the actual connect details.
# Exit 0 always — failures here must not affect the bot.
ISSUE="53f09217-992b-423e-b5cf-652b290b9dd7"
PAPERCLIP_URL="${PAPERCLIP_URL:-http://10.0.0.100:3100}"

if [ ! -f /run/secrets/paperclip-bearer ]; then
  echo "on-connected: no paperclip bearer mounted at /run/secrets/paperclip-bearer; skipping" >&2
  exit 0
fi

RAW=$(cat /run/secrets/paperclip-bearer)
case "$RAW" in
  *'"token"'*)
    TOKEN=$(printf '%s' "$RAW" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    ;;
  *)
    TOKEN="$RAW"
    ;;
esac
if [ -z "$TOKEN" ]; then
  echo "on-connected: empty paperclip bearer; skipping" >&2
  exit 0
fi

NOW=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
BODY="**Sexton back online.** First successful connect at ${NOW}. Avatar + initial description pushed. Ready to log chat per PHA-3099 spec."
ESC_BODY=$(printf '%s' "$BODY" | sed 's/\\/\\\\/g; s/"/\\"/g')
JSON="{\"body\":\"${ESC_BODY}\"}"

curl -sS -X POST "$PAPERCLIP_URL/api/issues/$ISSUE/comments" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$JSON" -o /tmp/on-connected-resp -w "%{http_code}"
echo "on-connected: posted (see /tmp/on-connected-resp)"
rm -f /tmp/on-connected-resp
exit 0
