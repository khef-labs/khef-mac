#!/usr/bin/env bash
# codeks — Launch Codex CLI with khef session registration (codex khef session).
#
# Generates a synthetic session ID, registers via heartbeat, gets a nickname,
# then launches codex with KHEF_SESSION_ID in the environment. On exit,
# deactivates the session.
#
# Usage: codeks [codex args...]
#        codeks --install    Add 'codeks' alias to shell profile
#
# All arguments after the script name are passed through to codex.

set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
API="${KHEF_API_URL:-http://localhost:3201}"

# --- Install mode ---
if [[ "${1:-}" == "--install" ]]; then
  profile="$HOME/.bash_profile"
  [[ "$(basename "${SHELL:-bash}")" == "zsh" ]] && profile="$HOME/.zshrc"

  alias_line="alias codeks='${SCRIPT_PATH}'"

  if grep -qF "$SCRIPT_PATH" "$profile" 2>/dev/null; then
    echo "codeks: alias already installed in $profile"
    exit 0
  fi

  if grep -qF "alias codeks=" "$profile" 2>/dev/null; then
    existing="$(grep "alias codeks=" "$profile")"
    echo "WARNING: existing codeks alias found in $profile:"
    echo "  $existing"
    echo "Replacing with: $alias_line"
    sed -i '' "s|^alias codeks=.*|${alias_line}|" "$profile"
    echo "codeks: alias updated in $profile"
    exit 0
  fi

  echo "" >> "$profile"
  echo "# khef codeks — launch codex with session registration" >> "$profile"
  echo "$alias_line" >> "$profile"
  echo "codeks: alias added to $profile (restart terminal or: source $profile)"
  exit 0
fi

# --- Preflight ---
if ! command -v codex &>/dev/null; then
  echo "Error: codex not found in PATH"
  exit 1
fi

# Generate a synthetic session ID (UUIDv4 via uuidgen, available on macOS)
SESSION_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"

# Build a synthetic file path for the heartbeat (identifies this as a codex session)
PROJECT_DIR="$(pwd)"
FILE_PATH="codex://${PROJECT_DIR}/${SESSION_ID}"

# Capture iTerm2 terminal session ID if available
TERM_SID="${ITERM_SESSION_ID:-}"
NICKNAME=""

# --- Register session ---
register() {
  local heartbeat_body
  heartbeat_body=$(printf '{"session_id":"%s","file_path":"%s","pid":%d' \
    "$SESSION_ID" "$FILE_PATH" "$$")
  if [ -n "$TERM_SID" ]; then
    heartbeat_body="${heartbeat_body},\"terminal_session_id\":\"${TERM_SID}\"}"
  else
    heartbeat_body="${heartbeat_body}}"
  fi

  curl -sf -X POST "$API/api/active-sessions/heartbeat" \
    -H "Content-Type: application/json" \
    -d "$heartbeat_body" > /dev/null 2>&1 || true

  # Get nickname
  local nick_response
  nick_response=$(curl -sf -X POST "$API/api/active-sessions/$SESSION_ID/nickname" \
    -H "Content-Type: application/json" \
    -d '{}' 2>/dev/null) || true

  NICKNAME=$(echo "$nick_response" | grep -o '"nickname":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -n "$NICKNAME" ]; then
    printf "\033[0;90mSession: %s | Nickname: \033[1;36m%s\033[0m\n" "$SESSION_ID" "$NICKNAME"
  else
    printf "\033[0;90mSession: %s\033[0m\n" "$SESSION_ID"
  fi
}

# --- Deactivate session ---
deactivate_session() {
  curl -sf -X POST "$API/api/active-sessions/$SESSION_ID/deactivate" \
    -H "Content-Type: application/json" > /dev/null 2>&1 || true
}

# --- Main ---
trap deactivate_session EXIT
trap 'deactivate_session; exit 130' INT
trap 'deactivate_session; exit 143' TERM

# Register and show nickname
if curl -sf "$API/health" > /dev/null 2>&1; then
  register
else
  printf "\033[1;33mWarning: khef API not reachable at %s — session not registered.\033[0m\n" "$API"
fi

# Export session ID and nickname so Codex MCP tools can use them
export KHEF_SESSION_ID="$SESSION_ID"
export KHEF_NICKNAME="$NICKNAME"

# Launch codex, passing all arguments through
codex "$@"
