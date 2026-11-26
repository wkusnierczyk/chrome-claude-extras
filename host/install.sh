#!/usr/bin/env bash
# Registers the native messaging host the Questions side panel reads through.
#
#   host/install.sh             install for Chrome, and for each other Chromium
#                               browser found (Chromium, Brave, Edge, Arc)
#   host/install.sh --uninstall remove it again
#
# macOS and Linux. Run it again after moving the repository.
set -euo pipefail

NAME=com.wkusnierczyk.claude_extras
EXTENSION_ID=oadhipdbgcnjhfcfiblhihcjdhlcilic
HERE=$(cd "$(dirname "$0")" && pwd)
HOST_SCRIPT="$HERE/claude_extras_host.py"
LAUNCHER_DIR="$HOME/.claude/decide-pane"
LAUNCHER="$LAUNCHER_DIR/claude_extras_host"

case "$(uname -s)" in
  Darwin)
    BASE="$HOME/Library/Application Support"
    CHROME="$BASE/Google/Chrome"
    OTHERS=("$BASE/Chromium" "$BASE/BraveSoftware/Brave-Browser" "$BASE/Microsoft Edge" "$BASE/Arc/User Data")
    ;;
  Linux)
    BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
    CHROME="$BASE/google-chrome"
    OTHERS=("$BASE/chromium" "$BASE/BraveSoftware/Brave-Browser" "$BASE/microsoft-edge")
    ;;
  *)
    echo "Only macOS and Linux are supported." >&2
    exit 1
    ;;
esac

BROWSERS=("$CHROME")
for dir in "${OTHERS[@]}"; do
  [ -d "$dir" ] && BROWSERS+=("$dir")
done

if [ "${1:-}" = "--uninstall" ]; then
  for dir in "${BROWSERS[@]}"; do
    rm -f "$dir/NativeMessagingHosts/$NAME.json"
  done
  rm -f "$LAUNCHER"
  echo "Removed $NAME."
  exit 0
fi

PYTHON=$(command -v python3 || true)
if [ -z "$PYTHON" ]; then
  echo "python3 is needed and was not found on PATH." >&2
  exit 1
fi

# Chrome starts the host with a bare PATH, so the launcher names python3 by
# its full path rather than relying on the script's shebang.
mkdir -p "$LAUNCHER_DIR"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec "$PYTHON" "$HOST_SCRIPT" "\$@"
EOF
chmod 755 "$LAUNCHER"

for dir in "${BROWSERS[@]}"; do
  mkdir -p "$dir/NativeMessagingHosts"
  cat > "$dir/NativeMessagingHosts/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "Extras for Claude: Claude Code session questions",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
  echo "Registered $NAME in $dir"
done
