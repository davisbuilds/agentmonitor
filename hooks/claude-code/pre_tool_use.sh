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

# These patterns match python/pre_tool_use.py; tests/hooks.test.ts holds both to
# one table of cases.
# An rm (optionally after sudo and the like) with the root or home directory, or
# everything in it, among its arguments. Matched per simple command, after quotes
# are dropped and ${HOME} is spelled $HOME.
DESTRUCTIVE_RM='^[[:blank:]]*(\{[[:blank:]]*)?((sudo|command|exec|nice|nohup|time|doas)[[:blank:]]+)*([^[:blank:]]*/)?rm([[:blank:]]+[^[:blank:]]+)*[[:blank:]]+(/|/\*|~|~/|~/\*|\$HOME|\$HOME/|\$HOME/\*)([[:blank:]]|$)'
# A file name that usually holds secrets, matched on the basename, ignoring case;
# example and template copies are not.
SENSITIVE_NAME='^(\.env(\..+)?|.+\.(env|pem|key|p12|pfx|secret|credentials)|\.?(credentials|secrets?)(\.(json|ya?ml|toml|ini|txt|env|xml|cfg|conf))?|id_(rsa|dsa|ecdsa|ed25519)|\.netrc|\.pgpass)$'
TEMPLATE_NAME='\.(example|sample|template|dist)$'

# --- Safety checks (only for Bash commands) ---
if [ "$SAFETY_ENABLED" = "1" ] && [ "$TOOL_NAME" = "Bash" ] && [ -n "$COMMAND" ]; then
  # Block destructive rm patterns
  if printf '%s\n' "$COMMAND" \
    | tr -d "\"'" \
    | sed 's/\${HOME}/$HOME/g' \
    | tr ';&|()`' '\n\n\n\n\n\n' \
    | grep -qE "$DESTRUCTIVE_RM"; then
    # Log the blocked attempt
    send_event "$(cat <<EOF
{
  "session_id": "$SESSION_ID_ESC",
  "agent_type": "claude_code",
  "event_type": "error",
  "tool_name": "$TOOL_NAME_ESC",
  "status": "error",
  "project": "$PROJECT_ESC",
  "cwd": "$(json_escape "$(extract_field cwd)")",
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
  FILE_NAME="${FILE_PATH##*/}"
  if printf '%s\n' "$FILE_NAME" | grep -qiE "$SENSITIVE_NAME" \
    && ! printf '%s\n' "$FILE_NAME" | grep -qiE "$TEMPLATE_NAME"; then
    send_event "$(cat <<EOF
{
  "session_id": "$SESSION_ID_ESC",
  "agent_type": "claude_code",
  "event_type": "tool_use",
  "tool_name": "$TOOL_NAME_ESC",
  "project": "$PROJECT_ESC",
  "cwd": "$(json_escape "$(extract_field cwd)")",
  "source": "hook",
  "metadata": {"security_warning": true, "file_path": "$FILE_PATH_ESC", "reason": "sensitive_file_access"}
}
EOF
)"
  fi
fi

exit 0
