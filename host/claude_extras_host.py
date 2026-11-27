#!/usr/bin/env python3
"""Native messaging host for Extras for Claude.

Chrome starts this program when the side panel asks for the questions of the
running Claude Code sessions. It reads the files the `decide-pane` mod writes,
one per session, and answers with them, latest first.

Protocol: each message is a 32-bit length in native byte order followed by
that many bytes of UTF-8 JSON, on stdin and stdout.
"""

import json
import struct
import sys
import time
from pathlib import Path

SESSIONS = Path.home() / ".claude" / "decide-pane" / "sessions"
# Whether a session may be cleared, as ~/.claude/session-state.sh records it
# ({"state": "busy" | "done", "why", "at"}), keyed by the same session id.
CLEAR_STATE = Path.home() / ".claude" / "session-state"
# A session not updated for this long is assumed gone (a crash leaves no end
# mark); its file is deleted, as is an ended session's after a short grace.
STALE_SECONDS = 7 * 24 * 3600
ENDED_SECONDS = 3600
# Chrome refuses a message from the host over 1 MB.
MAX_REPLY = 1024 * 1024 - 1024


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("=I", header)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(message):
    data = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def clear_state(session_id):
    path = CLEAR_STATE / f"{Path(session_id).name}.json"
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(state, dict) or not isinstance(state.get("at"), (int, float)):
        return None
    return state


def read_sessions():
    """Every session's record, ended ones included, latest first."""
    now = time.time()
    sessions = []
    if not SESSIONS.is_dir():
        return sessions
    for path in SESSIONS.glob("*.json"):
        try:
            modified = path.stat().st_mtime
            if now - modified > STALE_SECONDS:
                path.unlink(missing_ok=True)
                continue
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(doc, dict) or not isinstance(doc.get("sessionId"), str):
            continue
        if doc.get("isEnded") and now - modified > ENDED_SECONDS:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
            continue
        doc["modifiedAt"] = modified
        doc["clear"] = clear_state(doc["sessionId"])
        sessions.append(doc)
    sessions.sort(key=lambda doc: doc["modifiedAt"], reverse=True)
    return sessions


def list_sessions():
    return [doc for doc in read_sessions() if not doc.get("isEnded")]


def get_session(bridge_session_id):
    """The page's session: the live record for that Remote Control id, else
    the latest ended one (a /clear ends one session id and starts another
    under the same Remote Control id), so the rail can say it ended."""
    matches = [doc for doc in read_sessions() if doc.get("bridgeSessionId") == bridge_session_id]
    live = [doc for doc in matches if not doc.get("isEnded")]
    return (live or matches or [None])[0]


def main():
    message = read_message()
    if message is None:
        return
    if message.get("type") == "get":
        # One session, by its Remote Control id: the rail section's request.
        send_message({"session": get_session(message.get("bridgeSessionId"))})
        return
    if message.get("type") != "list":
        send_message({"error": f"unknown request: {message.get('type')!r}"})
        return
    sessions = list_sessions()
    reply = {"sessions": sessions}
    while sessions and len(json.dumps(reply).encode("utf-8")) > MAX_REPLY:
        sessions.pop()
    send_message(reply)


if __name__ == "__main__":
    main()
