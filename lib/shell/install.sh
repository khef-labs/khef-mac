#!/usr/bin/env bash
# Install khef shell helpers (cr, kf, vs) into the user's shell profile.
# Idempotent — safe to run multiple times.
#
# Usage:
#   bash lib/shell/install.sh              # auto-detect shell profile
#   bash lib/shell/install.sh <file>       # install to a specific file
#   npm run shell:install

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_FILE="$SCRIPT_DIR/claude.sh"

# Use provided file or detect shell profile
if [ -n "${1:-}" ]; then
  profile="$1"
else
  profile="$HOME/.bash_profile"
  [[ "$(basename "${SHELL:-bash}")" == "zsh" ]] && profile="$HOME/.zshrc"
fi

source_line="source '$SOURCE_FILE'"

# Already installed and pointing here
if grep -qF "$SOURCE_FILE" "$profile" 2>/dev/null; then
  echo "khef shell helpers: already installed in $profile"
  exit 0
fi

# Ensure target directory exists
mkdir -p "$(dirname "$profile")"

# Install
echo "" >> "$profile"
echo "# khef shell helpers (cr, kf, kv)" >> "$profile"
echo "$source_line" >> "$profile"
echo "khef shell helpers: installed in $profile"
echo "  Run 'source $profile' or open a new terminal to activate."
