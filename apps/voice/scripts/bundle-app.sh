#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Khef Voice"
EXECUTABLE_NAME="KhefVoiceApp"
BUILD_DIR="$ROOT_DIR/.build/release"
DIST_DIR="$ROOT_DIR/dist"
BUNDLE_DIR="$DIST_DIR/${APP_NAME}.app"
CONTENTS_DIR="$BUNDLE_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

mkdir -p "$DIST_DIR"

echo "Building release binary..."
cd "$ROOT_DIR"
# Force native arm64 build so the result is unaffected by being launched
# under Rosetta (which would otherwise produce an x86_64 binary that crashes
# in SFSpeech's caulk allocator under translation). Falls back to default
# behavior on Intel Macs where arm64 isn't supported.
if /usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null | grep -q '^1$'; then
  arch -arm64 swift build -c release
else
  swift build -c release
fi

echo "Creating app bundle..."
rm -rf "$BUNDLE_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cp "$BUILD_DIR/$EXECUTABLE_NAME" "$MACOS_DIR/$EXECUTABLE_NAME"
chmod +x "$MACOS_DIR/$EXECUTABLE_NAME"

if [ -f "$ROOT_DIR/icon.icns" ]; then
  cp "$ROOT_DIR/icon.icns" "$RESOURCES_DIR/AppIcon.icns"
fi

cat > "$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>KhefVoiceApp</string>
  <key>CFBundleIdentifier</key>
  <string>com.khef.voice</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Khef Voice</string>
  <key>CFBundleDisplayName</key>
  <string>Khef Voice</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>Khef Voice records speech to send live messages to active sessions.</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>Khef Voice uses on-device speech recognition only — no audio leaves your Mac. This permission dialog is required by macOS but all processing stays local.</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
</dict>
</plist>
PLIST

echo
echo "Bundle created:"
echo "  $BUNDLE_DIR"
echo
echo "Launch with:"
echo "  open \"$BUNDLE_DIR\""
