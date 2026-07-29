#!/usr/bin/env bash
# instructions_loaded.sh - Claude Code InstructionsLoaded hook -> AgentMonitor instruction_load event
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/send_event.sh"

read_hook_input

SESSION_ID="$(extract_field session_id)"
PROJECT="$(get_project)"
FILE_PATH="$(extract_field file_path)"
MEMORY_TYPE="$(extract_field memory_type)"
LOAD_REASON="$(extract_field load_reason)"
GLOBS_JSON="$(extract_json_field globs)"
TRIGGER_FILE_PATH="$(extract_field trigger_file_path)"
PARENT_FILE_PATH="$(extract_field parent_file_path)"

METADATA="{
  \"file_path\": \"$(json_escape "$FILE_PATH")\",
  \"memory_type\": \"$(json_escape "$MEMORY_TYPE")\",
  \"load_reason\": \"$(json_escape "$LOAD_REASON")\"
}"
if [ "$GLOBS_JSON" != "null" ]; then
  METADATA="${METADATA%?}, \"globs\": $GLOBS_JSON}"
fi
if [ -n "$TRIGGER_FILE_PATH" ]; then
  METADATA="${METADATA%?}, \"trigger_file_path\": \"$(json_escape "$TRIGGER_FILE_PATH")\"}"
fi
if [ -n "$PARENT_FILE_PATH" ]; then
  METADATA="${METADATA%?}, \"parent_file_path\": \"$(json_escape "$PARENT_FILE_PATH")\"}"
fi

send_event "$(cat <<EOF
{
  "session_id": "$(json_escape "$SESSION_ID")",
  "agent_type": "claude_code",
  "event_type": "instruction_load",
  "project": "$(json_escape "$PROJECT")",
  "source": "hook",
  "metadata": $METADATA
}
EOF
)"

exit 0
