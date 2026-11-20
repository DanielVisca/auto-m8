#!/usr/bin/env bash
# Claude Code hook: forwards the hook's stdin JSON to perch so status is exact.
# Fail-open: never prints, never blocks, always exits 0, even when perch is down.
# Installed/removed by scripts/perch-hooks.mjs.
url="${PERCH_URL:-http://127.0.0.1:${PERCH_PORT:-4777}}/api/hooks/claude"
body="$(cat)"
post() { curl -s -m 5 -o /dev/null -H 'content-type: application/json' --data-binary @- "$url" <<<"$body" 2>/dev/null; }
if [ -n "$PERCH_HOOK_SYNC" ]; then post; else post & disown; fi
exit 0
