#!/usr/bin/env bash
# post_tool_use.sh - Claude Code PostToolUse hook -> AgentStats tool_use event
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/send_event.sh"

read_hook_input

SESSION_ID="$(extract_field session_id)"
TOOL_NAME="$(extract_field tool_name)"
PROJECT="$(get_project)"

# Extract useful detail from tool_input depending on tool type
COMMAND="$(extract_nested tool_input.command)"
FILE_PATH="$(extract_nested tool_input.file_path)"
PATTERN="$(extract_nested tool_input.pattern)"
QUERY="$(extract_nested tool_input.query)"
URL="$(extract_nested tool_input.url)"

# JSON-escape all values before embedding in payload
SESSION_ID_ESC="$(json_escape "$SESSION_ID")"
TOOL_NAME_ESC="$(json_escape "$TOOL_NAME")"
PROJECT_ESC="$(json_escape "$PROJECT")"

# Build metadata object with escaped values
TOOL_USE_ID_ESC="$(json_escape "$(extract_field tool_use_id)")"
META="{\"tool_use_id\": \"$TOOL_USE_ID_ESC\""
[ -n "$COMMAND" ]   && META="$META, \"command\": \"$(json_escape "$COMMAND")\""
[ -n "$FILE_PATH" ] && META="$META, \"file_path\": \"$(json_escape "$FILE_PATH")\""
[ -n "$PATTERN" ]   && META="$META, \"pattern\": \"$(json_escape "$PATTERN")\""
[ -n "$QUERY" ]     && META="$META, \"query\": \"$(json_escape "$QUERY")\""
[ -n "$URL" ]       && META="$META, \"url\": \"$(json_escape "$URL")\""
META="$META}"

send_event "$(cat <<EOF
{
  "session_id": "$SESSION_ID_ESC",
  "agent_type": "claude_code",
  "event_type": "tool_use",
  "tool_name": "$TOOL_NAME_ESC",
  "project": "$PROJECT_ESC",
  "source": "hook",
  "metadata": $META
}
EOF
)"

exit 0
