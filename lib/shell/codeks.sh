#!/usr/bin/env bash
# codeks — Launch Codex CLI with khef session registration (codex khef session).
#
# Launches `codex` and concurrently watches ~/.codex/sessions/**/*.jsonl for
# the freshly-created transcript whose session_meta.payload.cwd matches the
# current working directory. Once found, registers it with khef using the
# real session UUID from session_meta.payload.id (no synthetic UUIDs).
#
# Usage: codeks [codex args...]
#        codeks --install    Add 'codeks' alias to shell profile
#
# All arguments after the script name are passed through to codex.

set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
API="${KHEF_API_URL:-http://localhost:3201}"
CODEX_SESSIONS_ROOT="$HOME/.codex/sessions"

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

CWD="$(pwd)"
TERM_SID="${ITERM_SESSION_ID:-}"
TERM_SID="${TERM_SID##*:}"
STATUS_FILE="${TMPDIR:-/tmp}/khef-codex-session-$$.env"
# A zero-byte marker created at launch time. BSD find on macOS rejects
# -newermt "@<epoch>", so we use -newer <marker> instead.
TIME_MARKER="${TMPDIR:-/tmp}/khef-codex-marker-$$"
: > "$TIME_MARKER"
DISCOVERY_PID=""

# Read a JSON field from stdin using python3 (always present on macOS).
# Returns empty on any parse failure.
json_field() {
  python3 -c "import sys, json
try:
  data = json.loads(sys.stdin.read())
  parts = '$1'.split('.')
  for p in parts:
    if data is None: break
    data = data.get(p) if isinstance(data, dict) else None
  print(data if isinstance(data, str) else '')
except Exception:
  pass" 2>/dev/null || true
}

set_iterm_user_var() {
  local name="$1"
  local value="${2:-}"
  [ -z "$value" ] && return 0

  local encoded
  encoded=$(printf '%s' "$value" | base64 | tr -d '\n')
  printf '\033]1337;SetUserVar=%s=%s\007' "$name" "$encoded" > /dev/tty 2>/dev/null || true
}

update_iterm_session_vars() {
  local session_id="$1"
  local nickname="$2"
  local short_session_id="${session_id%%-*}"

  # Existing iTerm profiles interpolate these historical Claude variable names.
  set_iterm_user_var "claude_session" "$session_id"
  set_iterm_user_var "claude_session_short" "$short_session_id"
  set_iterm_user_var "claude_nickname" "$nickname"

  set_iterm_user_var "codex_session" "$session_id"
  set_iterm_user_var "codex_session_short" "$short_session_id"
  set_iterm_user_var "codex_nickname" "$nickname"
}

# --- Background discovery: find this run's Codex JSONL and register it ---
discover_session() {
  set +e  # don't let pipefail/errexit kill the watcher
  local cwd="$1"
  local timeout_s=180
  local elapsed=0
  local poll=1

  while [ "$elapsed" -lt "$timeout_s" ]; do
    sleep "$poll"
    elapsed=$((elapsed + poll))
    # Gentle backoff so we don't hammer the filesystem
    if [ "$elapsed" -ge 10 ]; then poll=5
    elif [ "$elapsed" -ge 4 ]; then poll=2
    fi

    local match=""
    while IFS= read -r f; do
      [ -f "$f" ] || continue
      local meta_cwd
      meta_cwd=$(head -n1 "$f" 2>/dev/null | json_field "payload.cwd")
      if [ "$meta_cwd" = "$cwd" ]; then
        match="$f"
        break
      fi
    done < <(find "$CODEX_SESSIONS_ROOT" -type f -name '*.jsonl' -newer "$TIME_MARKER" 2>/dev/null)

    [ -z "$match" ] && continue

    local body
    body=$(printf '{"file_path":"%s","pid":%d' "$match" "$$")
    if [ -n "$TERM_SID" ]; then
      body="${body},\"terminal_session_id\":\"${TERM_SID}\""
    fi
    body="${body}}"

    local response
    response=$(curl -sf -X POST "$API/api/active-sessions/register-codex" \
      -H "Content-Type: application/json" \
      -d "$body" 2>/dev/null) || return 0

    local session_id nickname
    session_id=$(printf '%s' "$response" | json_field "session_id")
    nickname=$(printf '%s' "$response" | json_field "nickname")

    {
      echo "KHEF_SESSION_ID=$session_id"
      echo "KHEF_NICKNAME=$nickname"
      echo "KHEF_SESSION_FILE=$match"
    } > "$STATUS_FILE"

    update_iterm_session_vars "$session_id" "$nickname"
    return 0
  done
}

# --- Cleanup ---
cleanup() {
  if [ -n "$DISCOVERY_PID" ]; then
    kill "$DISCOVERY_PID" 2>/dev/null || true
  fi
  if [ -f "$STATUS_FILE" ]; then
    local sid nick
    sid=$(grep '^KHEF_SESSION_ID=' "$STATUS_FILE" | cut -d= -f2- || true)
    nick=$(grep '^KHEF_NICKNAME=' "$STATUS_FILE" | cut -d= -f2- || true)
    if [ -n "${sid:-}" ]; then
      curl -sf -X POST "$API/api/active-sessions/$sid/deactivate" \
        -H "Content-Type: application/json" > /dev/null 2>&1 || true
      if [ -n "${nick:-}" ]; then
        printf "\033[0;90mCodex session: %s | nickname: \033[1;36m%s\033[0m\n" "$sid" "$nick"
      else
        printf "\033[0;90mCodex session: %s\033[0m\n" "$sid"
      fi
    fi
    rm -f "$STATUS_FILE"
  fi
  rm -f "$TIME_MARKER"
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# --- Main ---
if curl -sf "$API/health" > /dev/null 2>&1; then
  discover_session "$CWD" &
  DISCOVERY_PID=$!
else
  printf "\033[1;33mWarning: khef API not reachable at %s — Codex session won't be registered.\033[0m\n" "$API"
fi

# Hand the TTY to Codex. Discovery, registration, and deactivation all run
# out of band; the TUI is never touched.
codex "$@"
