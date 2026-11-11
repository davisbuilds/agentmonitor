"""send_event.py - Shared helper for POSTing events to AgentMonitor.

Imported by individual hook scripts. Uses only stdlib (no pip dependencies).

Usage:
    from send_event import read_hook_input, send_event, get_project
"""

import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

AGENTMONITOR_URL = os.environ.get("AGENTMONITOR_URL", "http://127.0.0.1:3141")

_hook_input: dict = {}


def read_hook_input() -> dict:
    """Read and parse JSON from stdin. Call once per hook invocation."""
    global _hook_input
    raw = sys.stdin.read()
    try:
        _hook_input = json.loads(raw)
    except json.JSONDecodeError:
        _hook_input = {}
    return _hook_input


def get_input() -> dict:
    """Return the parsed hook input (must call read_hook_input first)."""
    return _hook_input


def extract(field: str, default: str = "") -> str:
    """Extract a top-level string field from hook input."""
    val = _hook_input.get(field, default)
    return str(val) if val is not None else default


def extract_nested(path: str, default: str = "") -> str:
    """Extract a nested field using dot notation (e.g., 'tool_input.command')."""
    parts = path.split(".")
    obj = _hook_input
    for part in parts:
        if isinstance(obj, dict):
            obj = obj.get(part)
        else:
            return default
    return str(obj) if obj is not None else default


def get_project() -> str:
    """Derive project name from cwd (basename of working directory)."""
    cwd = extract("cwd")
    return Path(cwd).name if cwd else ""


# Where an event goes when the server cannot take it; the server drains it.
# Keep the default in step with hookSpoolDir in src/config.ts.
AGENTMONITOR_HOOK_SPOOL_DIR = os.environ.get(
    "AGENTMONITOR_HOOK_SPOOL_DIR",
    os.path.join(os.path.expanduser("~"), ".local", "state", "agentmonitor", "hook-spool"),
)

# The POST runs in a detached child so the hook can exit at once, the way the
# shell hooks background curl. A thread cannot do this: the interpreter kills
# daemon threads on exit, so it had to wait (up to 2s) for a slow server.
# When the server cannot be reached in time, the child spools the event for
# the server to store later: one line, private to the user, published by
# renaming its temporary file so the server never reads half of it.
_POST_CHILD = """
import os, sys, time, urllib.request
url, spool, event_id = sys.argv[1], sys.argv[2], sys.argv[3]
body = sys.stdin.buffer.read()
try:
    urllib.request.urlopen(urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST",
    ), timeout=5)
except urllib.error.HTTPError:
    pass  # the server answered: nothing to retry
except Exception:
    try:
        os.umask(0o077)
        os.makedirs(spool, exist_ok=True)
        if sum(1 for name in os.listdir(spool) if name.endswith(".json")) < 10000:
            tmp = os.path.join(spool, "." + event_id + ".tmp")
            with open(tmp, "wb") as handle:
                handle.write(body.replace(b"\\n", b" ") + b"\\n")
            os.rename(tmp, os.path.join(spool, "%d-%s.json" % (int(time.time()), event_id)))
    except Exception:
        pass
"""


def send_event(payload: dict) -> None:
    """POST an event payload to AgentMonitor. Fire-and-forget (detached child).

    Each event carries its own id and time, so one spooled while the server was
    unreachable is stored at the time it happened, and stored once.
    """
    try:
        event_id = str(uuid.uuid4())
        stamped = {
            "event_id": event_id,
            "client_timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            **payload,
        }
        detach = (
            {"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
            if sys.platform == "win32"
            else {"start_new_session": True}
        )
        child = subprocess.Popen(
            [sys.executable, "-c", _POST_CHILD, f"{AGENTMONITOR_URL}/api/events", AGENTMONITOR_HOOK_SPOOL_DIR, event_id],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **detach,
        )
        child.stdin.write(json.dumps(stamped).encode("utf-8"))
        child.stdin.close()
    except Exception:
        pass  # fire-and-forget
