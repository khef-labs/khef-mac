#!/usr/bin/env bash
#
# Send a text message to a Claude Code session via iTerm2 keystroke simulation.
#
# Usage:
#   ./scripts/send-to-session.sh <session-id-or-nickname> <message>
#
# Examples:
#   ./scripts/send-to-session.sh ridge "check the deploy status"
#   ./scripts/send-to-session.sh f458cefd-49e2-436f-896a-a2c301cafb00 "ping"

set -euo pipefail

API_URL="${KHEF_API_URL:-http://localhost:3201}"

if [ $# -lt 2 ]; then
  echo "Usage: $0 <session-id-or-nickname> <message>"
  exit 1
fi

TARGET="$1"
shift
MESSAGE="$*"

# Resolve nickname to session ID if needed (not a UUID pattern)
if [[ ! "$TARGET" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  # Look up by nickname from active sessions
  SESSION_DATA=$(curl -s "$API_URL/api/active-sessions" | jq -r --arg nick "$TARGET" \
    '.sessions[] | select(.nickname == $nick and .status == "active") | .session_id' | head -1)
  if [ -z "$SESSION_DATA" ]; then
    echo "Error: No active session found with nickname '$TARGET'"
    exit 1
  fi
  TARGET="$SESSION_DATA"
fi

# Get the terminal_session_id from the active sessions API
TERMINAL_SID=$(curl -s "$API_URL/api/active-sessions/by-session-id/$TARGET" | jq -r '.session.terminal_session_id // empty')

if [ -z "$TERMINAL_SID" ]; then
  echo "Error: No terminal_session_id found for session '$TARGET'"
  echo "The session may not have heartbeated with iTerm2 info yet."
  exit 1
fi

echo "Sending to iTerm2 session $TERMINAL_SID..."

# Use osascript to write text to the specific iTerm2 session
osascript <<EOF
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if id of s is "$TERMINAL_SID" then
          tell s to write text "$MESSAGE"
          return
        end if
      end repeat
    end repeat
  end repeat
end tell
error "iTerm2 session $TERMINAL_SID not found"
EOF

echo "Sent."
