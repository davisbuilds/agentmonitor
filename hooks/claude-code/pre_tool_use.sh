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

# WHY: The shell and Python hooks must block the same destructive commands across wrappers and directory spellings.
DESTRUCTIVE_RM='^[[:blank:]]*(\{[[:blank:]]*)?(([A-Za-z_][A-Za-z0-9_]*=[^[:blank:]]*|(sudo|command|exec|nice|nohup|time|doas|env)([[:blank:]]+-[^[:blank:]]+([[:blank:]]+[^-[:blank:]][^[:blank:]]*)?)*)[[:blank:]]+)*([^[:blank:]]*/)?rm([[:blank:]]+[^[:blank:]]+)*[[:blank:]]+(/|/\*|~|~/|~/\*|\$HOME|\$HOME/|\$HOME/\*)([[:blank:]]|$)'
# WHY: Quoted substitutions still execute commands. Streaming characters avoids quadratic work for long inputs.
SPLIT_COMMANDS='
function out(ch) { printf "%s", ((q != "" && (ch == " " || ch == "\t")) ? "_" : ch) }
function push(k) { d++; kind[d] = k; saved[d] = q; q = ""; printf "\n" }
function pop() { q = saved[d]; d--; printf "\n" }
{
  for (i = 1; i <= length($0); i++) {
    c = substr($0, i, 1)
    if (q == "\047") { if (c == "\047") q = ""; else out(c); continue }
    if (q == "\"") {
      if (c == "\"") q = ""
      else if (c == "$" && substr($0, i + 1, 1) == "(") { push("("); i++ }
      else if (c == "`") push("`")
      else out(c)
      continue
    }
    if (c == "\047" || c == "\"") { q = c; continue }
    if (c == "(") { push("("); continue }
    if (c == ")") { if (d > 0) pop(); else printf "\n"; continue }
    if (c == "`") { if (d > 0 && kind[d] == "`") pop(); else push("`"); continue }
    if (c == ";" || c == "&" || c == "|") { printf "\n"; continue }
    out(c)
  }
  if (q == "") printf "\n"; else out(" ")
}
END { printf "\n" }'
SENSITIVE_NAME='^(\.env(\..+)?|.+\.(env|pem|key|p12|pfx|secret|credentials)|\.?(credentials|secrets?)(\.(json|ya?ml|toml|ini|txt|env|xml|cfg|conf))?|id_(rsa|dsa|ecdsa|ed25519)|\.netrc|\.pgpass)$'
TEMPLATE_NAME='\.(example|sample|template|dist)$'

if [ "$SAFETY_ENABLED" = "1" ] && [ "$TOOL_NAME" = "Bash" ] && [ -n "$COMMAND" ]; then
  # WHY: An early grep match can close the pipe and make the hook fail under pipefail.
  SIMPLE_COMMANDS="$(printf '%s\n' "$COMMAND" | sed 's/\${HOME}/$HOME/g' | awk "$SPLIT_COMMANDS")"
  if grep -qE "$DESTRUCTIVE_RM" <<<"$SIMPLE_COMMANDS"; then
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

if [ "$SAFETY_ENABLED" = "1" ] && [ -n "$FILE_PATH" ]; then
  FILE_NAME="${FILE_PATH##*/}"
  if grep -qiE "$SENSITIVE_NAME" <<<"$FILE_NAME" \
    && ! grep -qiE "$TEMPLATE_NAME" <<<"$FILE_NAME"; then
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
