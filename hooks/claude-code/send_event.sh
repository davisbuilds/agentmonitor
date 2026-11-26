#!/usr/bin/env bash
# send_event.sh - Shared helper for POSTing events to AgentMonitor.
# Sourced by individual hook scripts. Not executed directly.
#
# Usage: source send_event.sh; send_event "$json_payload"

AGENTMONITOR_URL="${AGENTMONITOR_URL:-http://127.0.0.1:3141}"

read_hook_input() {
  HOOK_INPUT="$(cat)"
}

extract_field() {
  local field="$1"
  if command -v jq &>/dev/null; then
    echo "$HOOK_INPUT" | jq -r ".$field // empty" 2>/dev/null
  else
    echo "$HOOK_INPUT" |
      grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" |
      head -1 |
      sed 's/.*: *"//;s/"$//' ||
      true
  fi
}

extract_nested() {
  local path="$1"
  if command -v jq &>/dev/null; then
    echo "$HOOK_INPUT" | jq -r ".$path // empty" 2>/dev/null
  else
    echo ""
  fi
}

# WHY: Without jq, guessing at nested JSON could send malformed tool metadata.
extract_json_field() {
  local field="$1"
  if command -v jq &>/dev/null; then
    echo "$HOOK_INPUT" | jq -c --arg field "$field" '.[$field] // null' 2>/dev/null
  else
    echo "null"
  fi
}

get_project() {
  local cwd
  cwd="$(extract_field cwd)"
  if [ -n "$cwd" ]; then
    basename "$cwd"
  fi
}

# WHY: Hooks call this under set -e; a detached or missing repository must still allow delivery.
get_branch() {
  local cwd
  cwd="$(extract_field cwd)"
  [ -n "$cwd" ] || return 0
  # WHY: An unborn branch already has a symbolic name even though rev-parse fails.
  git -C "$cwd" symbolic-ref --short -q HEAD 2>/dev/null \
    || git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null \
    || true
}

json_escape() {
  local s="$1"
  if command -v jq &>/dev/null; then
    printf '%s' "$s" | jq -Rs '.' 2>/dev/null | sed 's/^"//;s/"$//'
  else
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\t'/\\t}"
    s="${s//$'\r'/\\r}"
    printf '%s' "$s"
  fi
}

# WHY: The server must find events spooled while it was offline.
AGENTMONITOR_HOOK_SPOOL_DIR="${AGENTMONITOR_HOOK_SPOOL_DIR:-$HOME/.local/state/agentmonitor/hook-spool}"
HOOK_SPOOL_MAX_FILES=10000

# WHY: A retry can deliver an already accepted event, while two legitimate hook loads need independent IDs. Hooks can inherit a bare PATH.
new_event_id() {
  local id=""
  command -v uuidgen >/dev/null 2>&1 && id="$(uuidgen 2>/dev/null)"
  [ -n "$id" ] || id="hook-$$-$RANDOM$RANDOM$RANDOM$RANDOM"
  printf '%s' "$id"
}

now_seconds() {
  local seconds=""
  command -v date >/dev/null 2>&1 && seconds="$(date +%s 2>/dev/null)"
  printf '%s' "${seconds:-0}"
}

# WHY: A later replay must preserve the order in which the events occurred.
event_order() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    printf '%s' "${EPOCHREALTIME//[.,]/}"
    return
  fi
  local us=""
  command -v perl >/dev/null 2>&1 && us="$(perl -MTime::HiRes=time -e 'printf "%d", time() * 1e6' 2>/dev/null)"
  [ -n "$us" ] || us="$(now_seconds)000000"
  printf '%s' "$us"
}

# WHY: The server may drain concurrently and must only see complete event files.
spool_event() {
  local payload="$1" id="$2" order="$3" dir="$AGENTMONITOR_HOOK_SPOOL_DIR"
  umask 077
  mkdir -p "$dir" 2>/dev/null || return 0
  # WHY: A prolonged outage must not exhaust disk space.
  local spooled
  shopt -s nullglob
  spooled=("$dir"/*.json)
  [ "${#spooled[@]}" -lt "$HOOK_SPOOL_MAX_FILES" ] || return 0
  local tmp="$dir/.$id.tmp"
  if ! { printf '%s\n' "${payload//$'\n'/ }" >"$tmp" && mv "$tmp" "$dir/$order-$id.json"; } 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null
  fi
}

send_event() {
  local id stamp="" payload order
  order="$(event_order)"
  id="$(new_event_id)"
  command -v date >/dev/null 2>&1 && stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"
  payload="{\"event_id\":\"$id\",${stamp:+\"client_timestamp\":\"$stamp\",}${1#*\{}"
  (
    curl -s -o /dev/null -X POST "${AGENTMONITOR_URL}/api/events" \
      -H "Content-Type: application/json" \
      -d "$payload" \
      --connect-timeout 2 \
      --max-time 5 \
      || spool_event "$payload" "$id" "$order"
  ) >/dev/null 2>&1 &
}
