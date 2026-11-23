#!/bin/zsh -l
# What the auto-m8 Dock/Spotlight icon runs: open auto-m8, and if it is stuck, repair it so clicking the
# icon is always enough (no Mac restart). Before this the icon ran `open -n`, and a hung app kept
# the single-instance lock, so the new copy quit at once and nothing happened (2026-11-18).
#   1. auto-m8 answers: show its window.
#   2. The app runs but the server doesn't answer: give the app's own watchdog 25s to bring it back.
#   3. Still nothing: stop the app and its server (TERM, then KILL), free memory held by idle local
#      models if the Mac is swapping hard, and start auto-m8 fresh. Running chats are detached and
#      reattach on the next boot, so nothing is lost.
ROOT="${0:A:h:h}"
[ -f "$ROOT/server/main.ts" ] || ROOT="$HOME/Development/perch"
PORT="${PERCH_PORT:-4777}"
ELECTRON="$ROOT/node_modules/electron/dist/Electron.app"
LOG="$HOME/Library/Application Support/perch/server.log"
log() { print -r -- "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] auto-m8 icon: $*" >> "$LOG" 2>/dev/null }
note() { osascript -e "display notification \"$1\" with title \"auto-m8\"" >/dev/null 2>&1 }
healthy() { curl -sf -m "${1:-5}" "http://127.0.0.1:$PORT/api/health" >/dev/null }
app_pids() { pgrep -f "$ELECTRON/Contents/MacOS/Electron $ROOT\$" }
launch() { open -n -a "$ELECTRON" --args "$ROOT" }

# Idle local models can hold ~20 GB; when swap is nearly full they are what starves auto-m8.
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

if [ -z "$(app_pids)" ]; then
  relieve_memory
  launch; exit 0
fi
if healthy 5; then launch; exit 0; fi # second-instance: the running app shows its window

note "auto-m8 isn't answering, repairing it…"
log "server not answering; waiting for the app's watchdog"
relieve_memory
for i in {1..25}; do healthy 2 && { launch; exit 0 }; sleep 1; done

log "still not answering after 25s; restarting the app and its server"
print -n "auto-m8 icon: app and server were unresponsive; restarted from the Dock icon" > "$HOME/Library/Application Support/perch/restart-reason" 2>/dev/null
pids=($(app_pids) $(lsof -ti tcp:$PORT -sTCP:LISTEN))
kill -TERM $pids 2>/dev/null
for i in {1..20}; do kill -0 $pids 2>/dev/null || break; sleep 0.5; done
for p in $pids; do kill -0 $p 2>/dev/null && { log "pid $p ignored TERM, sending KILL"; kill -KILL $p 2>/dev/null }; done
sleep 1
launch
for i in {1..60}; do healthy 2 && { note "auto-m8 is back"; log "back after repair"; exit 0 }; sleep 1; done
note "auto-m8 didn't come back in a minute. Check Activity Monitor for a stuck 'node' process."
log "did not come back within 60s of relaunch"
exit 1
