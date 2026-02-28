#!/usr/bin/env bash
# pre_tool_use.sh - Claude Code PreToolUse hook with optional safety checks.
#
# Safety behavior:
#   - Blocks destructive commands (rm -rf /, rm -rf ~, etc.)
#   - Logs security events for sensitive file access (.env, .pem, credentials)
#   - Exit 0 = allow, Exit 2 = block
#
# Set AGENTMONITOR_SAFETY=0 to disable safety checks (telemetry-only mode).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/send_event.sh"

read_hook_input

SESSION_ID="$(extract_field session_id)"
TOOL_NAME="$(extract_field tool_name)"
PROJECT="$(get_project)"
COMMAND="$(extract_nested tool_input.command)"
FILE_PATH="$(extract_nested tool_input.file_path)"

SESSION_ID_ESC="$(json_escape "$SESSION_ID")"
TOOL_NAME_ESC="$(json_escape "$TOOL_NAME")"
PROJECT_ESC="$(json_escape "$PROJECT")"
COMMAND_ESC="$(json_escape "$COMMAND")"
FILE_PATH_ESC="$(json_escape "$FILE_PATH")"

SAFETY_ENABLED="${AGENTMONITOR_SAFETY:-1}"

# --- Safety checks (only for Bash commands) ---
if [ "$SAFETY_ENABLED" = "1" ] && [ "$TOOL_NAME" = "Bash" ] && [ -n "$COMMAND" ]; then
  # Block destructive rm patterns
  if echo "$COMMAND" | grep -qE 'rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+)*(\/|~|\$HOME)(\s|$)'; then
    # Log the blocked attempt
    send_event "$(cat <<EOF
{
  "session_id": "$SESSION_ID_ESC",
  "agent_type": "claude_code",
  "event_type": "error",
  "tool_name": "$TOOL_NAME_ESC",
  "status": "error",
  "project": "$PROJECT_ESC",
  "source": "hook",
  "metadata": {"blocked": true, "reason": "destructive_command", "command": "$COMMAND_ESC"}
}
EOF
)"
    echo "AgentMonitor: Blocked destructive command: $COMMAND" >&2
    exit 2
  fi
fi

# --- Security warnings (log but don't block) ---
if [ "$SAFETY_ENABLED" = "1" ] && [ -n "$FILE_PATH" ]; then
  if echo "$FILE_PATH" | grep -qE '\.(env|pem|key|credentials|secret)$'; then
    send_event "$(cat <<EOF
{
  "session_id": "$SESSION_ID_ESC",
  "agent_type": "claude_code",
  "event_type": "tool_use",
  "tool_name": "$TOOL_NAME_ESC",
  "project": "$PROJECT_ESC",
  "source": "hook",
  "metadata": {"security_warning": true, "file_path": "$FILE_PATH_ESC", "reason": "sensitive_file_access"}
}
EOF
)"
  fi
fi

exit 0
