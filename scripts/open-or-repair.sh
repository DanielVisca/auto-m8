#!/bin/zsh -l
# What the Mothership Dock/Spotlight icon runs: open Mothership, and if it is stuck, repair it so clicking the
# icon is always enough (no Mac restart). Before this the icon ran `open -n`, and a hung app kept
# the single-instance lock, so the new copy quit at once and nothing happened (2026-11-18).
#   1. Mothership answers: show its window.
#   2. The app runs but the server doesn't answer: give the app's own watchdog 25s to bring it back.
#   3. Still nothing: stop the app and its server (TERM, then KILL), free memory held by idle local
#      models if the Mac is swapping hard, and start Mothership fresh. Running chats are detached and
#      reattach on the next boot, so nothing is lost.
ROOT="${0:A:h:h}"
[ -f "$ROOT/server/main.ts" ] || ROOT="$HOME/Development/perch"
PORT="${PERCH_PORT:-4777}"
ELECTRON="$ROOT/node_modules/electron/dist/Electron.app"
LOG="$HOME/Library/Application Support/perch/server.log"
log() { print -r -- "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Mothership icon: $*" >> "$LOG" 2>/dev/null }
note() { osascript -e "display notification \"$1\" with title \"Mothership\"" >/dev/null 2>&1 }
health_json() { curl -sf -m "${1:-5}" "http://127.0.0.1:$PORT/api/health" 2>/dev/null }
healthy() { health_json "$1" >/dev/null }
# Which checkout actually answered (server/main.ts reports its own cwd as `root`). Two checkouts
# can share this data dir/port - a rename in progress, a stray second clone - and treating any
# answer as "I'm up" silently hands off to the OTHER checkout's window with no error at all
# (2026-11-19: `open -n` on mothership quit at once, nothing happened, nothing was logged).
healthy_root() { health_json "$1" | /usr/bin/python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("root",""))
except Exception: pass' 2>/dev/null }
foreign_owner() { local owner; owner="$(healthy_root "$1")"; [ -n "$owner" ] && [ "$owner" != "$ROOT" ] && print -r -- "$owner" }
app_pids() { pgrep -f "$ELECTRON/Contents/MacOS/Electron $ROOT\$" }
launch() { open -n -a "$ELECTRON" --args "$ROOT" }

# Idle local models can hold ~20 GB; when swap is nearly full they are what starves Mothership.
relieve_memory() {
  local used total
  used=$(sysctl -n vm.swapusage | sed -E 's/.*used = ([0-9.]+)M.*/\1/')
  total=$(sysctl -n vm.swapusage | sed -E 's/total = ([0-9.]+)M.*/\1/')
  if [ -n "$used" ] && [ -n "$total" ] && awk "BEGIN{exit !($total > 0 && $used / $total > 0.7)}"; then
    for m in $(curl -sf -m 3 http://127.0.0.1:11434/api/ps | /usr/bin/python3 -c 'import json,sys; print(" ".join(m["name"] for m in json.load(sys.stdin).get("models", [])))' 2>/dev/null); do
      curl -sf -m 10 http://127.0.0.1:11434/api/generate -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null && log "unloaded local model $m (swap ${used}M of ${total}M)"
    done
  fi
}

# Stop whatever is running for this checkout (TERM, then KILL if it ignores that), then launch
# fresh and wait for it to answer. Shared by the "still not answering" repair path below and by
# `--restart`, which `npm run update` uses: a *healthy* old build must not be left running just
# because it answers - "healthy" and "the build you just shipped" are different questions.
kill_and_relaunch() {
  local why="$1" pids=($(app_pids) $(lsof -ti tcp:$PORT -sTCP:LISTEN))
  if [ -n "$pids" ]; then
    kill -TERM $pids 2>/dev/null
    for i in {1..20}; do kill -0 $pids 2>/dev/null || break; sleep 0.5; done
    for p in $pids; do kill -0 $p 2>/dev/null && { log "pid $p ignored TERM, sending KILL"; kill -KILL $p 2>/dev/null }; done
  fi
  sleep 1
  launch
  for i in {1..60}; do healthy 2 && { note "Mothership is back"; log "back after $why"; exit 0 }; sleep 1; done
  note "Mothership didn't come back in a minute. Check Activity Monitor for a stuck 'node' process."
  log "did not come back within 60s of $why"
  exit 1
}

restart=0
[ "${1:-}" = "--restart" ] && restart=1

owner="$(foreign_owner 5)"
if [ -n "$owner" ]; then
  note "Another checkout already owns port $PORT: $owner"
  log "port $PORT is answered by a different checkout ($owner, this is $ROOT); not touching it, to avoid a silent handoff to its window"
  print -r -- "Another checkout is already running on port $PORT: $owner\nStop it first (or run this checkout on its own PERCH_PORT/PERCH_DATA) before opening this one." >&2
  exit 1
fi

if [ "$restart" = 1 ]; then
  log "forced restart requested (e.g. after \`npm run update\`)"
  relieve_memory
  kill_and_relaunch "forced restart"
fi

if [ -z "$(app_pids)" ]; then
  relieve_memory
  launch; exit 0
fi
if healthy 5; then launch; exit 0; fi # second-instance: the running app shows its window

note "Mothership isn't answering, repairing it…"
log "server not answering; waiting for the app's watchdog"
relieve_memory
for i in {1..25}; do healthy 2 && { launch; exit 0 }; sleep 1; done

log "still not answering after 25s; restarting the app and its server"
print -n "Mothership icon: app and server were unresponsive; restarted from the Dock icon" > "$HOME/Library/Application Support/perch/restart-reason" 2>/dev/null
kill_and_relaunch "repair"
