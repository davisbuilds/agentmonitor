#!/usr/bin/env python3
"""Claude Code InstructionsLoaded hook -> AgentMonitor instruction_load event."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from send_event import get_project, read_hook_input, send_event

hook_input = read_hook_input()
metadata = {
    field: hook_input[field]
    for field in (
        "file_path",
        "memory_type",
        "load_reason",
        "globs",
        "trigger_file_path",
        "parent_file_path",
    )
    if field in hook_input and hook_input[field] is not None
}

send_event({
    "session_id": str(hook_input.get("session_id", "")),
    "agent_type": "claude_code",
    "event_type": "instruction_load",
    "project": get_project(),
    "source": "hook",
    "metadata": metadata,
})
