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
# An rm with the root or home directory, or everything in it, among its
# arguments. It may follow variable assignments and wrappers such as sudo, with
# their options. Matched per simple command (see SPLIT_COMMANDS), after
# ${HOME} is spelled $HOME.
DESTRUCTIVE_RM='^[[:blank:]]*(\{[[:blank:]]*)?(([A-Za-z_][A-Za-z0-9_]*=[^[:blank:]]*|(sudo|command|exec|nice|nohup|time|doas|env)([[:blank:]]+-[^[:blank:]]+([[:blank:]]+[^-[:blank:]][^[:blank:]]*)?)*)[[:blank:]]+)*([^[:blank:]]*/)?rm([[:blank:]]+[^[:blank:]]+)*[[:blank:]]+(/|/\*|~|~/|~/\*|\$HOME|\$HOME/|\$HOME/\*)([[:blank:]]|$)'
# One simple command per output line. Outside quotes it splits at ; & | ( )
# backticks and newlines. Inside double quotes only a $( ) or backtick
# substitution is code: the scanner splits there and reads its body as
# unquoted, returning to the quote at the closing ) or backtick (a stack keeps
# nesting). Quote characters are dropped and quoted blanks become _, so a quoted
# value stays one word. Prints each character as it goes, so a long command
# costs linear time.
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
# A file name that usually holds secrets, matched on the basename, ignoring case;
# example and template copies are not.
SENSITIVE_NAME='^(\.env(\..+)?|.+\.(env|pem|key|p12|pfx|secret|credentials)|\.?(credentials|secrets?)(\.(json|ya?ml|toml|ini|txt|env|xml|cfg|conf))?|id_(rsa|dsa|ecdsa|ed25519)|\.netrc|\.pgpass)$'
TEMPLATE_NAME='\.(example|sample|template|dist)$'

# --- Safety checks (only for Bash commands) ---
if [ "$SAFETY_ENABLED" = "1" ] && [ "$TOOL_NAME" = "Bash" ] && [ -n "$COMMAND" ]; then
  # Block destructive rm patterns. Every stage reads all of its input, and grep
  # reads a here-string, so an early match cannot fail the pipeline on SIGPIPE.
  SIMPLE_COMMANDS="$(printf '%s\n' "$COMMAND" | sed 's/\${HOME}/$HOME/g' | awk "$SPLIT_COMMANDS")"
  if grep -qE "$DESTRUCTIVE_RM" <<<"$SIMPLE_COMMANDS"; then
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
