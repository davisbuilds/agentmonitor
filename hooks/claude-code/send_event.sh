#!/usr/bin/env bash
# send_event.sh - Shared helper for POSTing events to AgentMonitor.
# Sourced by individual hook scripts. Not executed directly.
#
# Usage: source send_event.sh; send_event "$json_payload"

AGENTMONITOR_URL="${AGENTMONITOR_URL:-http://127.0.0.1:3141}"

# Read all of stdin into HOOK_INPUT (call once per hook invocation)
read_hook_input() {
  HOOK_INPUT="$(cat)"
}

# Extract a string field from HOOK_INPUT using lightweight parsing.
# Falls back to empty string if jq is unavailable or field is missing.
extract_field() {
  local field="$1"
  if command -v jq &>/dev/null; then
    echo "$HOOK_INPUT" | jq -r ".$field // empty" 2>/dev/null
  else
    # Fallback: naive grep for simple top-level string fields
    echo "$HOOK_INPUT" |
      grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" |
      head -1 |
      sed 's/.*: *"//;s/"$//' ||
      true
  fi
}

# Extract a nested field (e.g., tool_input.command)
extract_nested() {
  local path="$1"
  if command -v jq &>/dev/null; then
    echo "$HOOK_INPUT" | jq -r ".$path // empty" 2>/dev/null
  else
    echo ""
  fi
}

# Extract a top-level field while preserving its JSON representation.
# Without jq, optional structured fields are unavailable rather than guessed.
extract_json_field() {
  local field="$1"
  if command -v jq &>/dev/null; then
    echo "$HOOK_INPUT" | jq -c --arg field "$field" '.[$field] // null' 2>/dev/null
  else
    echo "null"
  fi
}

# Derive project name from cwd (basename of working directory)
get_project() {
  local cwd
  cwd="$(extract_field cwd)"
  if [ -n "$cwd" ]; then
    basename "$cwd"
  fi
}

# Derive git branch from cwd
get_branch() {
  local cwd
  cwd="$(extract_field cwd)"
  if [ -n "$cwd" ] && [ -d "$cwd/.git" ] || git -C "$cwd" rev-parse --git-dir &>/dev/null 2>&1; then
    git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null
  fi
}

# Escape a string for safe embedding in a JSON value.
# Handles backslashes, double quotes, newlines, tabs, and carriage returns.
json_escape() {
  local s="$1"
  if command -v jq &>/dev/null; then
    printf '%s' "$s" | jq -Rs '.' 2>/dev/null | sed 's/^"//;s/"$//'
  else
    # Bash-native escape: \, ", newline, tab, carriage return.
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\t'/\\t}"
    s="${s//$'\r'/\\r}"
    printf '%s' "$s"
  fi
}

# POST an event payload to AgentMonitor. Fire-and-forget (backgrounded).
send_event() {
  local payload="$1"
  curl -s -X POST "${AGENTMONITOR_URL}/api/events" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    --connect-timeout 2 \
    --max-time 5 \
    >/dev/null 2>&1 &
}
