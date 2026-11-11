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
# Callers assign under `set -e`, so a git failure must never escape: it would
# kill the hook before it sends anything.
get_branch() {
  local cwd
  cwd="$(extract_field cwd)"
  [ -n "$cwd" ] || return 0
  # symbolic-ref names the branch even before the first commit, where rev-parse
  # exits 128; a detached HEAD falls through to rev-parse's "HEAD".
  git -C "$cwd" symbolic-ref --short -q HEAD 2>/dev/null \
    || git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null \
    || true
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

# Where an event goes when the server cannot take it; the server drains it.
# Keep the default in step with hookSpoolDir in src/config.ts.
AGENTMONITOR_HOOK_SPOOL_DIR="${AGENTMONITOR_HOOK_SPOOL_DIR:-$HOME/.local/state/agentmonitor/hook-spool}"
HOOK_SPOOL_MAX_FILES=10000

# A fresh id per event, so a spooled event the server also received is stored
# once, while two loads of the same file stay two events. Hooks must work with
# a bare PATH, so each tool has a fallback that bash provides itself.
new_event_id() {
  local id=""
  command -v uuidgen >/dev/null 2>&1 && id="$(uuidgen 2>/dev/null)"
  [ -n "$id" ] || id="hook-$$-$RANDOM$RANDOM$RANDOM$RANDOM"
  printf '%s' "$id"
}

# Unix seconds, or 0 when date is unavailable (the spool still orders by name).
now_seconds() {
  local seconds=""
  command -v date >/dev/null 2>&1 && seconds="$(date +%s 2>/dev/null)"
  printf '%s' "${seconds:-0}"
}

# Write one event into the spool: a single line, private to the user, published
# by renaming its temporary file so the server never reads half of it.
spool_event() {
  local payload="$1" id="$2" dir="$AGENTMONITOR_HOOK_SPOOL_DIR"
  umask 077
  mkdir -p "$dir" 2>/dev/null || return 0
  # Bounded: a server that never returns must not fill the disk.
  local spooled
  shopt -s nullglob
  spooled=("$dir"/*.json)
  [ "${#spooled[@]}" -lt "$HOOK_SPOOL_MAX_FILES" ] || return 0
  local tmp="$dir/.$id.tmp"
  if ! { printf '%s\n' "${payload//$'\n'/ }" >"$tmp" && mv "$tmp" "$dir/$(now_seconds)-$id.json"; } 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null
  fi
}

# POST an event payload to AgentMonitor. Fire-and-forget (backgrounded). Each
# event carries its own id and time; when the server cannot be reached in time,
# it is spooled for the server to store later rather than lost.
send_event() {
  local id stamp="" payload
  id="$(new_event_id)"
  command -v date >/dev/null 2>&1 && stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"
  # The payload is a JSON object: put the id (and time, when known) first inside it.
  payload="{\"event_id\":\"$id\",${stamp:+\"client_timestamp\":\"$stamp\",}${1#*\{}"
  (
    curl -s -o /dev/null -X POST "${AGENTMONITOR_URL}/api/events" \
      -H "Content-Type: application/json" \
      -d "$payload" \
      --connect-timeout 2 \
      --max-time 5 \
      || spool_event "$payload" "$id"
  ) >/dev/null 2>&1 &
}
