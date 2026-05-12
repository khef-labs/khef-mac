#!/usr/bin/env bash
# Check if ClamAV (clamscan) is installed. Used by optional kdag jobs that
# scan downloaded files for malware. Called as part of `npm run install:all`.

if command -v clamscan &>/dev/null; then
  echo "ClamAV $(clamscan --version) found"
  exit 0
fi

echo ""
echo "  ClamAV (clamscan) is not installed — optional."
echo "  Some kdag jobs use it to virus-scan downloaded files."
echo ""
echo "  Install with:"
echo "    brew install clamav && freshclam              # macOS"
echo "    sudo apt install clamav && sudo freshclam     # Debian/Ubuntu"
echo ""
echo "  Khef will run fine without ClamAV; those jobs will skip scanning."

# Don't fail the install — it's optional functionality
exit 0
