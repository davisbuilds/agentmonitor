#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./hooks/claude-code/install-statusline-bridge.sh [--url URL] [--uninstall]

Wrap the current Claude Code statusline command so AgentMonitor can ingest
native Claude quota data from the official statusline payload.
EOF
}

AGENTMONITOR_URL="${AGENTMONITOR_URL:-http://127.0.0.1:3141}"
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      AGENTMONITOR_URL="$2"
      shift 2
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to update ~/.claude/settings.json" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
FORWARD_FILE="$CLAUDE_DIR/agentmonitor-statusline-forward.txt"
BRIDGE_PATH="$SCRIPT_DIR/statusline_bridge.sh"
BRIDGE_COMMAND="AGENTMONITOR_URL=\"$AGENTMONITOR_URL\" \"$BRIDGE_PATH\""

mkdir -p "$CLAUDE_DIR"

if [[ ! -f "$SETTINGS_FILE" ]]; then
  echo "{}" >"$SETTINGS_FILE"
fi

tmp_file="$(mktemp)"
cleanup() {
  rm -f "$tmp_file"
}
trap cleanup EXIT

if [[ "$UNINSTALL" -eq 1 ]]; then
  if [[ ! -f "$FORWARD_FILE" ]]; then
    echo "No saved original statusline command found at $FORWARD_FILE" >&2
    exit 1
  fi

  original_command="$(cat "$FORWARD_FILE")"
  jq --arg command "$original_command" '
    .statusLine = (.statusLine // {})
    | .statusLine.command = $command
  ' "$SETTINGS_FILE" >"$tmp_file"
  mv "$tmp_file" "$SETTINGS_FILE"
  rm -f "$FORWARD_FILE"
  echo "Restored original Claude Code statusline command."
  exit 0
fi

current_command="$(jq -r '.statusLine.command // empty' "$SETTINGS_FILE")"
if [[ -z "$current_command" ]]; then
  echo "No existing Claude Code statusLine.command found in $SETTINGS_FILE" >&2
  exit 1
fi

if [[ "$current_command" == "$BRIDGE_COMMAND" ]]; then
  echo "Claude statusline bridge is already installed."
  exit 0
fi

printf '%s' "$current_command" >"$FORWARD_FILE"

jq --arg command "$BRIDGE_COMMAND" '
  .statusLine = (.statusLine // {})
  | .statusLine.command = $command
' "$SETTINGS_FILE" >"$tmp_file"
mv "$tmp_file" "$SETTINGS_FILE"

echo "Installed Claude statusline quota bridge."
echo "Forward command saved to $FORWARD_FILE"
echo "Restart Claude Code to load the updated statusline command."
