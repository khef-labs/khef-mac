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

# --- Nickname resolution for `codeks resume <name>` ---
# Codex's own `resume` subcommand only knows session UUIDs. Translate khef
# nicknames here so `codeks resume erica` works the same way `cr briny` does
# for claude. Bare UUIDs and the no-arg interactive form pass straight through.

# Resolve a khef nickname to the most recent codex session UUID.
# Echoes the UUID on success, nothing on miss. Never errors out — callers
# decide what to do with empty output.
resolve_codex_nickname() {
  local nick="${1:-}"
  [ -z "$nick" ] && return 0
  curl -sf "$API/api/sessions/by-nickname/$nick" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    codex = [s for s in (data.get('sessions') or []) if s.get('assistant') == 'codex-cli']
    if codex:
        print(codex[-1].get('session_id') or '')
except Exception:
    pass
" 2>/dev/null
}

if [[ "${1:-}" == "resume" && -n "${2:-}" ]]; then
  # Pass through full UUIDs and any 8+ hex-char prefix unchanged.
  if [[ "$2" =~ ^[0-9a-f-]{8,}$ ]]; then
    : # codex resume handles it directly
  else
    nick="$2"
    resolved=$(resolve_codex_nickname "$nick")
    if [ -n "$resolved" ]; then
      printf "\033[0;90mResuming codex session: \033[1;36m%s\033[0m (%s)\n" "$nick" "$resolved"
      # Rewrite the args so the rest of the script + codex see the UUID.
      set -- "resume" "$resolved" "${@:3}"
    else
      printf "\033[1;31mERROR: No codex session found for nickname '%s'.\033[0m\n" "$nick" >&2
      printf "\033[0;90mTip: run \033[1mcodeks resume\033[0;90m with no name for the interactive picker.\033[0m\n" >&2
      exit 1
    fi
  fi
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
HEARTBEAT_INTERVAL_S="${KHEF_CODEX_HEARTBEAT_S:-30}"

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

# --- Background heartbeat: keep the session marked active in khef ---
# Codex has no per-prompt hook (Claude Code's UserPromptSubmit re-heartbeats
# on every prompt). Without this loop, a single scanner miss on the API side
# can mark the session inactive until the user restarts codex. The interval
# is configurable via KHEF_CODEX_HEARTBEAT_S (default 30s).
heartbeat_loop() {
  set +e
  local sid="$1"
  local file_path="$2"
  local interval="$3"
  local body

  while sleep "$interval"; do
    body=$(printf '{"session_id":"%s","file_path":"%s","pid":%d' "$sid" "$file_path" "$$")
    if [ -n "$TERM_SID" ]; then
      body="${body},\"terminal_session_id\":\"${TERM_SID}\""
    fi
    body="${body}}"
    curl -sf -X POST "$API/api/active-sessions/heartbeat" \
      -H "Content-Type: application/json" \
      -d "$body" > /dev/null 2>&1 || true
  done
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

    heartbeat_loop "$session_id" "$match" "$HEARTBEAT_INTERVAL_S" &
    local heartbeat_pid=$!

    {
      echo "KHEF_SESSION_ID=$session_id"
      echo "KHEF_NICKNAME=$nickname"
      echo "KHEF_SESSION_FILE=$match"
      echo "KHEF_HEARTBEAT_PID=$heartbeat_pid"
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
    local sid nick heartbeat_pid
    sid=$(grep '^KHEF_SESSION_ID=' "$STATUS_FILE" | cut -d= -f2- || true)
    nick=$(grep '^KHEF_NICKNAME=' "$STATUS_FILE" | cut -d= -f2- || true)
    heartbeat_pid=$(grep '^KHEF_HEARTBEAT_PID=' "$STATUS_FILE" | cut -d= -f2- || true)
    if [ -n "${heartbeat_pid:-}" ]; then
      kill "$heartbeat_pid" 2>/dev/null || true
    fi
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
