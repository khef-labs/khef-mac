#!/usr/bin/env bash
# Check if ripgrep (rg) is installed. Used by the editor's cross-file search.
# Called as part of `npm run install:all`.

if command -v rg &>/dev/null; then
  echo "ripgrep $(rg --version | head -1) found"
  exit 0
fi

echo ""
echo "  ripgrep (rg) is not installed."
echo "  The editor's cross-file search (Cmd+Shift+F) requires it."
echo ""
echo "  Install with:"
echo "    brew install ripgrep        # macOS"
echo "    sudo apt install ripgrep    # Debian/Ubuntu"
echo "    cargo install ripgrep       # Rust/Cargo"
echo ""

# Don't fail the install — it's optional functionality
exit 0
