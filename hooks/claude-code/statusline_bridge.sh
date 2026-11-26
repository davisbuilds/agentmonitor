#!/usr/bin/env bash
set -uo pipefail

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
FORWARD_FILE="${AGENTMONITOR_STATUSLINE_FORWARD_FILE:-$CLAUDE_DIR/agentmonitor-statusline-forward.txt}"
AGENTMONITOR_URL="${AGENTMONITOR_URL:-http://127.0.0.1:3141}"

payload="$(cat)"

# WHY: A delayed monitor must not stall statusline rendering or hold its stdout open.
if [[ -n "$payload" ]]; then
  curl -fsS \
    -m 1 \
    -X POST \
    -H 'Content-Type: application/json' \
    --data-binary "$payload" \
    "$AGENTMONITOR_URL/api/provider-quotas/claude/statusline" \
    </dev/null >/dev/null 2>&1 &
fi

if [[ -f "$FORWARD_FILE" ]]; then
  forward_command="$(cat "$FORWARD_FILE")"
  if [[ -n "$forward_command" ]]; then
    printf '%s' "$payload" | bash -lc "$forward_command"
    exit $?
  fi
fi

exit 0
