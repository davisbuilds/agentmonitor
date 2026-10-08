#!/usr/bin/env python3
"""pre_tool_use.py - Claude Code PreToolUse hook with optional safety checks.

Safety behavior:
  - Blocks destructive commands (rm -rf /, rm -rf ~, etc.)
  - Logs security events for sensitive file access (.env, .pem, credentials)
  - Exit 0 = allow, Exit 2 = block

Set AGENTMONITOR_SAFETY=0 to disable safety checks (telemetry-only mode).
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from send_event import read_hook_input, extract, extract_nested, get_project, send_event

read_hook_input()

SESSION_ID = extract("session_id")
TOOL_NAME = extract("tool_name")
PROJECT = get_project()
COMMAND = extract_nested("tool_input.command")
FILE_PATH = extract_nested("tool_input.file_path")

SAFETY_ENABLED = os.environ.get("AGENTMONITOR_SAFETY", "1") == "1"

# These patterns match pre_tool_use.sh; tests/hooks.test.ts holds both to one
# table of cases.
# An rm (optionally after sudo and the like) with the root or home directory, or
# everything in it, among its arguments. Matched per simple command, after quotes
# are dropped and ${HOME} is spelled $HOME.
DESTRUCTIVE_RM = re.compile(
    r'^[ \t]*(\{[ \t]*)?((sudo|command|exec|nice|nohup|time|doas)[ \t]+)*([^ \t]*/)?rm([ \t]+[^ \t]+)*'
    r'[ \t]+(/|/\*|~|~/|~/\*|\$HOME|\$HOME/|\$HOME/\*)([ \t]|$)'
)
# A file name that usually holds secrets, matched on the basename, ignoring case;
# example and template copies are not.
SENSITIVE_NAME = re.compile(
    r'^(\.env(\..+)?|.+\.(env|pem|key|p12|pfx|secret|credentials)'
    r'|\.?(credentials|secrets?)(\.(json|ya?ml|toml|ini|txt|env|xml|cfg|conf))?'
    r'|id_(rsa|dsa|ecdsa|ed25519)|\.netrc|\.pgpass)$',
    re.IGNORECASE,
)
TEMPLATE_NAME = re.compile(r'\.(example|sample|template|dist)$', re.IGNORECASE)


def is_destructive(command):
    normalized = re.sub(r'["\']', '', command).replace('${HOME}', '$HOME')
    return any(DESTRUCTIVE_RM.search(part) for part in re.split(r'[;&|()`\n]', normalized))


def is_sensitive(file_path):
    name = file_path.rsplit('/', 1)[-1]
    return bool(SENSITIVE_NAME.search(name)) and not TEMPLATE_NAME.search(name)


# --- Safety checks (only for Bash commands) ---
if SAFETY_ENABLED and TOOL_NAME == "Bash" and COMMAND:
    if is_destructive(COMMAND):
        send_event({
            "session_id": SESSION_ID,
            "agent_type": "claude_code",
            "event_type": "error",
            "tool_name": TOOL_NAME,
            "status": "error",
            "project": PROJECT,
            "cwd": extract("cwd"),
            "source": "hook",
            "metadata": {
                "blocked": True,
                "reason": "destructive_command",
                "command": COMMAND,
            },
        })
        print(f"AgentMonitor: Blocked destructive command: {COMMAND}", file=sys.stderr)
        sys.exit(2)

# --- Security warnings (log but don't block) ---
if SAFETY_ENABLED and FILE_PATH:
    if is_sensitive(FILE_PATH):
        send_event({
            "session_id": SESSION_ID,
            "agent_type": "claude_code",
            "event_type": "tool_use",
            "tool_name": TOOL_NAME,
            "project": PROJECT,
            "cwd": extract("cwd"),
            "source": "hook",
            "metadata": {
                "security_warning": True,
                "file_path": FILE_PATH,
                "reason": "sensitive_file_access",
            },
        })

sys.exit(0)
