#!/usr/bin/env bash
# kf-edit — open a file or directory in the khef editor
#
# Usage:
#   kf <path>          Open file or directory
#   kf <file>:<line>   Open file at line number
#   kf                 Open editor at current directory
#   kf --install       Add kf alias to shell profile (idempotent, safe for scripts)

set -euo pipefail

KHEF_UI_URL="${KHEF_UI_URL:-http://localhost:5174}"
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

# --- Install mode ---
if [[ "${1:-}" == "--install" ]]; then
  # Detect shell profile
  profile="$HOME/.bash_profile"
  [[ "$(basename "${SHELL:-bash}")" == "zsh" ]] && profile="$HOME/.zshrc"

  alias_line="alias kf='${SCRIPT_PATH}'"

  # Already installed and pointing here — nothing to do
  if grep -qF "$SCRIPT_PATH" "$profile" 2>/dev/null; then
    echo "kf: alias already installed in $profile"
    exit 0
  fi

  # Check if kf alias exists in profile pointing elsewhere
  if grep -qF "alias kf=" "$profile" 2>/dev/null; then
    existing="$(grep "alias kf=" "$profile")"
    echo "WARNING: existing kf alias found in $profile:"
    echo "  $existing"
    echo "Replacing with: $alias_line"
    sed -i '' "s|^alias kf=.*|${alias_line}|" "$profile"
    echo "kf: alias updated in $profile"
    exit 0
  fi

  # Check if kf exists as a system command (not an alias)
  if command -v kf &>/dev/null; then
    echo "WARNING: 'kf' already exists as a command: $(command -v kf)"
    echo "Skipping alias install. To override, manually add to $profile:"
    echo "  $alias_line"
    exit 0
  fi

  # Fresh install
  echo "" >> "$profile"
  echo "# khef editor — open files/dirs in khef UI" >> "$profile"
  echo "$alias_line" >> "$profile"
  echo "kf: alias added to $profile (restart terminal or: source $profile)"
  exit 0
fi

# --- Normal mode ---
arg="${1:-}"

# URL-encode helper
encode() { python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$1"; }

# No argument: open editor rooted at cwd
if [[ -z "$arg" ]]; then
  open "${KHEF_UI_URL}/editor?root=$(encode "$(pwd)")"
  exit 0
fi

# Parse optional :line suffix (e.g., file.ts:42)
line=""
if [[ "$arg" =~ ^(.+):([0-9]+)$ ]]; then
  arg="${BASH_REMATCH[1]}"
  line="${BASH_REMATCH[2]}"
fi

# Resolve to absolute path
resolved="$(cd "$(dirname "$arg")" 2>/dev/null && pwd)/$(basename "$arg")"
if [[ ! -e "$resolved" ]]; then
  echo "kf: $arg: No such file or directory" >&2
  exit 1
fi

if [[ -d "$resolved" ]]; then
  open "${KHEF_UI_URL}/editor?root=$(encode "$resolved")"
elif [[ -f "$resolved" ]]; then
  url="${KHEF_UI_URL}/editor?file=$(encode "$resolved")"
  [[ -n "$line" ]] && url+="&line=${line}"
  open "$url"
else
  echo "kf: $arg: Not a file or directory" >&2
  exit 1
fi
