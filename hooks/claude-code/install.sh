#!/usr/bin/env bash
# install.sh - Register AgentMonitor hooks in Claude Code settings.
#
# Usage:
#   ./install.sh                      # Install shell hooks (default)
#   ./install.sh --python             # Install Python hooks instead
#   ./install.sh --url http://host:port  # Custom AgentMonitor URL
#   ./install.sh --uninstall          # Remove AgentMonitor hooks
#
# This script modifies ~/.claude/settings.json. A backup is created
# before any changes are made.
set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS_FILE="$CLAUDE_CONFIG_DIR/settings.json"
USE_PYTHON=false
AGENTMONITOR_URL="http://127.0.0.1:3141"
UNINSTALL=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --python)  USE_PYTHON=true; shift ;;
    --url)     AGENTMONITOR_URL="$2"; shift 2 ;;
    --uninstall) UNINSTALL=true; shift ;;
    -h|--help)
      echo "Usage: ./install.sh [--python] [--url URL] [--uninstall]"
      echo ""
      echo "  --python     Use Python hook scripts instead of shell"
      echo "  --url URL    AgentMonitor server URL (default: http://127.0.0.1:3141)"
      echo "  --uninstall  Remove AgentMonitor hooks from settings"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Ensure jq is available
if ! command -v jq &>/dev/null; then
  echo "Error: jq is required for install/uninstall. Install it with:"
  echo "  brew install jq      (macOS)"
  echo "  apt install jq       (Debian/Ubuntu)"
  echo "  pacman -S jq         (Arch)"
  exit 1
fi

# Ensure settings directory exists
mkdir -p "$(dirname "$SETTINGS_FILE")"

# Create settings file if it doesn't exist
if [ ! -f "$SETTINGS_FILE" ]; then
  echo '{}' > "$SETTINGS_FILE"
fi

# Backup existing settings
BACKUP="${SETTINGS_FILE}.bak.$(date +%Y%m%d%H%M%S)"
cp "$SETTINGS_FILE" "$BACKUP"
echo "Backed up settings to $BACKUP"

if [ "$UNINSTALL" = true ]; then
  # Remove only hooks owned by this installer. AGENTMONITOR_URL may also be
  # used by unrelated commands, so the executable path is the ownership marker.
  jq '
    def without_agentmonitor:
      map(
        .hooks = (
          (.hooks // []) |
          map(
            select((((.command? // "") | test("/hooks/claude-code/")) | not))
          )
        )
      ) | map(select(.hooks | length > 0));

    if .hooks then
      .hooks |= (
        with_entries(.value |= without_agentmonitor) |
        with_entries(select(.value | length > 0))
      ) |
      if .hooks == {} then del(.hooks) else . end
    else . end
  ' "$SETTINGS_FILE" > "${SETTINGS_FILE}.tmp" && mv "${SETTINGS_FILE}.tmp" "$SETTINGS_FILE"

  echo ""
  echo "AgentMonitor hooks removed from $SETTINGS_FILE"
  exit 0
fi

# Determine script paths based on language choice
if [ "$USE_PYTHON" = true ]; then
  SESSION_START="python3 $HOOKS_DIR/python/session_start.py"
  SESSION_END="python3 $HOOKS_DIR/python/session_end.py"
  POST_TOOL="python3 $HOOKS_DIR/python/post_tool_use.py"
  PRE_TOOL="python3 $HOOKS_DIR/python/pre_tool_use.py"
  INSTRUCTIONS_LOADED="python3 $HOOKS_DIR/python/instructions_loaded.py"
  USER_PROMPT="$HOOKS_DIR/user_prompt_submit.sh"  # No Python variant yet
  LANG_LABEL="Python"
else
  SESSION_START="$HOOKS_DIR/session_start.sh"
  SESSION_END="$HOOKS_DIR/session_end.sh"
  POST_TOOL="$HOOKS_DIR/post_tool_use.sh"
  PRE_TOOL="$HOOKS_DIR/pre_tool_use.sh"
  INSTRUCTIONS_LOADED="$HOOKS_DIR/instructions_loaded.sh"
  USER_PROMPT="$HOOKS_DIR/user_prompt_submit.sh"
  LANG_LABEL="Shell"
fi

# Build the hooks configuration and merge into settings
jq --arg session_start "$SESSION_START" \
   --arg session_end "$SESSION_END" \
   --arg post_tool "$POST_TOOL" \
   --arg pre_tool "$PRE_TOOL" \
   --arg instructions_loaded "$INSTRUCTIONS_LOADED" \
   --arg user_prompt "$USER_PROMPT" \
   --arg url "$AGENTMONITOR_URL" \
   '
  def without_agentmonitor:
    map(
      .hooks |= map(
        select((((.command? // "") | test("/hooks/claude-code/")) | not))
      )
    ) | map(select(.hooks | length > 0));

  .hooks = (.hooks // {}) |
  .hooks["SessionStart"] = (
    ((.hooks["SessionStart"] // []) | without_agentmonitor) +
    [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": (
              "AGENTMONITOR_URL=" + $url +
              " AGENTMONITOR_INSTRUCTION_LOAD_INSTRUMENTED=1 " +
              $session_start
            ),
            "timeout": 10,
            "async": true
          }
        ]
      }
    ]
  ) |
  .hooks["Stop"] = (
    ((.hooks["Stop"] // []) | without_agentmonitor) +
    [
      {
        "hooks": [
          {
            "type": "command",
            "command": ("AGENTMONITOR_URL=" + $url + " " + $session_end),
            "timeout": 10,
            "async": true
          }
        ]
      }
    ]
  ) |
  .hooks["PostToolUse"] = (
    ((.hooks["PostToolUse"] // []) | without_agentmonitor) +
    [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": ("AGENTMONITOR_URL=" + $url + " " + $post_tool),
            "timeout": 10,
            "async": true
          }
        ]
      }
    ]
  ) |
  .hooks["PreToolUse"] = (
    ((.hooks["PreToolUse"] // []) | without_agentmonitor) +
    [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": ("AGENTMONITOR_URL=" + $url + " " + $pre_tool),
            "timeout": 10,
            "async": false,
            "statusMessage": "AgentMonitor: checking safety..."
          }
        ]
      }
    ]
  ) |
  .hooks["UserPromptSubmit"] = (
    ((.hooks["UserPromptSubmit"] // []) | without_agentmonitor) +
    [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": ("AGENTMONITOR_URL=" + $url + " " + $user_prompt),
            "timeout": 10,
            "async": true
          }
        ]
      }
    ]
  ) |
  .hooks["InstructionsLoaded"] = (
    ((.hooks["InstructionsLoaded"] // []) | without_agentmonitor) +
    [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": ("AGENTMONITOR_URL=" + $url + " " + $instructions_loaded),
            "timeout": 10,
            "async": true
          }
        ]
      }
    ]
  )
' "$SETTINGS_FILE" > "${SETTINGS_FILE}.tmp" && mv "${SETTINGS_FILE}.tmp" "$SETTINGS_FILE"

echo ""
echo "AgentMonitor hooks installed ($LANG_LABEL scripts)"
echo ""
echo "  Settings:     $SETTINGS_FILE"
echo "  Server URL:   $AGENTMONITOR_URL"
echo "  Hooks dir:    $HOOKS_DIR"
echo ""
echo "  SessionStart  -> session_start event (async)"
echo "  Stop          -> session_end event (async)"
echo "  PostToolUse   -> tool_use event (async)"
echo "  PreToolUse    -> safety checks on Bash (sync, blocks destructive commands)"
echo "  UserPromptSubmit -> user_prompt event (async)"
echo "  InstructionsLoaded -> instruction_load event (async, metadata only)"
echo ""
echo "Start AgentMonitor with 'pnpm dev' then use Claude Code as normal."
echo "Events will appear in the dashboard at $AGENTMONITOR_URL"
