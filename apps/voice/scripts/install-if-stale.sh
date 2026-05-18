#!/usr/bin/env bash
# Build and install Khef Voice.app into ~/Applications only when source inputs
# have changed since the last install. Skips bundling, killing the running app,
# and replacing the bundle when nothing relevant has changed — which preserves
# the macOS mic / speech recognition permissions granted to the installed app.
#
# Pass --force to bypass the staleness check and reinstall unconditionally.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Khef Voice"
EXECUTABLE_NAME="KhefVoiceApp"
DIST_DIR="$ROOT_DIR/dist"
INSTALL_DIR="$HOME/Applications"
INSTALLED_APP="$INSTALL_DIR/${APP_NAME}.app"
INSTALLED_BIN="$INSTALLED_APP/Contents/MacOS/$EXECUTABLE_NAME"
HASH_FILE="$INSTALLED_APP/Contents/Resources/.khef-build-hash"

force=false
if [[ "${1:-}" == "--force" ]]; then
  force=true
fi

hash_inputs() {
  {
    if [[ -d "$ROOT_DIR/Sources" ]]; then
      find "$ROOT_DIR/Sources" -type f -exec shasum -a 256 {} +
    fi
    [[ -f "$ROOT_DIR/Package.swift" ]] && shasum -a 256 "$ROOT_DIR/Package.swift"
    [[ -f "$ROOT_DIR/icon.icns" ]] && shasum -a 256 "$ROOT_DIR/icon.icns"
    [[ -f "$ROOT_DIR/scripts/bundle-app.sh" ]] && shasum -a 256 "$ROOT_DIR/scripts/bundle-app.sh"
    [[ -f "$ROOT_DIR/scripts/install-if-stale.sh" ]] && shasum -a 256 "$ROOT_DIR/scripts/install-if-stale.sh"
  } | LC_ALL=C sort | shasum -a 256 | awk '{print $1}'
}

current_hash="$(hash_inputs)"

if [[ "$force" == false ]] && [[ -x "$INSTALLED_BIN" ]] && [[ -f "$HASH_FILE" ]]; then
  stored="$(cat "$HASH_FILE" 2>/dev/null || true)"
  if [[ "$stored" == "$current_hash" ]]; then
    echo "Khef Voice.app is up to date (${current_hash:0:12}) — skipping rebuild/install."
    exit 0
  fi
  echo "Khef Voice.app inputs changed (${stored:0:12} -> ${current_hash:0:12}) — reinstalling..."
else
  echo "Khef Voice.app not installed or missing hash — building and installing..."
fi

bash "$ROOT_DIR/scripts/bundle-app.sh"

pkill -x "$EXECUTABLE_NAME" 2>/dev/null || true
mkdir -p "$INSTALL_DIR"
rm -rf "$INSTALLED_APP"
cp -R "$DIST_DIR/${APP_NAME}.app" "$INSTALLED_APP"

echo "$current_hash" > "$INSTALLED_APP/Contents/Resources/.khef-build-hash"
echo "Installed $INSTALLED_APP (hash: ${current_hash:0:12})"
