#!/bin/sh
# Restart Mothership's server to load new server code, saying why. Running chats reattach and the open
# app rides through the gap without an error.
#   scripts/restart.sh "what changed"          coalesced: joins a queued restart, or queues one if Mothership
#                                               started under 3 minutes ago (one restart, every reason kept)
#   scripts/restart.sh --now "what changed"     emergency: restart at once (takes any queued reasons along)
# Use this instead of `kill $(lsof -ti tcp:4777)`: the reason lands in Settings → Health → Availability.
PORT="${PERCH_PORT:-4777}"
NOW=false
if [ "$1" = "--now" ]; then NOW=true; shift; fi
REASON="${1:-restart for new server code}"
OLD=$(curl -sf -m 3 "http://127.0.0.1:$PORT/api/health" | sed -E 's/.*"pid":([0-9]+).*/\1/')
BODY=$(REASON="$REASON" NOW="$NOW" node -e 'process.stdout.write(JSON.stringify({ reason: process.env.REASON, now: process.env.NOW === "true" }))')
REPLY=$(curl -sf -m 5 -X POST -H 'Content-Type: application/json' -d "$BODY" "http://127.0.0.1:$PORT/api/restart")
if [ -z "$REPLY" ]; then
  echo "Mothership didn't answer; stopping it by signal" >&2
  [ -n "$OLD" ] && kill -TERM "$OLD"
elif printf '%s' "$REPLY" | grep -q '"queued":true'; then
  printf '%s' "$REPLY" | node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"))
    const at = new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    console.log(`queued, will restart at ${at} with ${r.reasons} reason${r.reasons === 1 ? "" : "s"} (use --now only for an emergency)`)'
  exit 0
fi
for i in $(seq 1 60); do
  NEW=$(curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" | sed -E 's/.*"pid":([0-9]+).*/\1/')
  if [ -n "$NEW" ] && [ "$NEW" != "$OLD" ]; then echo "Mothership restarted: pid $OLD -> $NEW"; exit 0; fi
  perl -e 'select(undef,undef,undef,0.5)'
done
echo "Mothership did not come back within 30s (is the app running? it brings the server back)" >&2; exit 1
