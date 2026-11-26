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


def list_sessions():
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
        if doc.get("isEnded"):
            if now - modified > ENDED_SECONDS:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
            continue
        doc["modifiedAt"] = modified
        sessions.append(doc)
    sessions.sort(key=lambda doc: doc["modifiedAt"], reverse=True)
    return sessions


def main():
    message = read_message()
    if message is None:
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
