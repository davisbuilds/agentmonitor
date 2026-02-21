#!/usr/bin/env bash
# session_start.sh - Claude Code SessionStart hook -> AgentStats session_start event
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/send_event.sh"

read_hook_input

SESSION_ID="$(extract_field session_id)"
MODEL="$(extract_field model)"
PROJECT="$(get_project)"
BRANCH="$(get_branch)"
SOURCE="$(extract_field source)"

send_event "$(cat <<EOF
{
  "session_id": "$(json_escape "$SESSION_ID")",
  "agent_type": "claude_code",
  "event_type": "session_start",
  "project": "$(json_escape "$PROJECT")",
  "branch": "$(json_escape "$BRANCH")",
  "model": "$(json_escape "$MODEL")",
  "source": "hook",
  "metadata": {"hook_source": "$(json_escape "$SOURCE")"}
}
EOF
)"

exit 0
