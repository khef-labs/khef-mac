#!/usr/bin/env bash
set -uo pipefail

# Best-effort install of the Python embedding sidecar dependencies used by the
# kvec vector pipeline. Warns and exits 0 if Python isn't available so the
# overall `npm run setup` keeps moving — vector search is opt-in via settings.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQ_FILE="${ROOT_DIR}/apps/api/requirements.txt"
MIN_PY="3.10"

if [[ ! -f "${REQ_FILE}" ]]; then
  echo "Skipping Python sidecar setup: ${REQ_FILE} not found." >&2
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  cat <<EOF >&2
Skipping Python sidecar setup: python3 is not on PATH.
The kvec embedding sidecar needs Python ${MIN_PY}+.
Install Python (https://www.python.org/downloads/ or 'brew install python@3.13'),
then run: npm run python:setup
EOF
  exit 0
fi

PY_VER="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if ! python3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"; then
  echo "Skipping Python sidecar setup: python3 is ${PY_VER}, need ${MIN_PY}+." >&2
  exit 0
fi

if ! command -v pip3 >/dev/null 2>&1; then
  echo "Skipping Python sidecar setup: pip3 is not on PATH." >&2
  echo "Install pip for python3, then run: npm run python:setup" >&2
  exit 0
fi

echo "Installing Python sidecar dependencies (Python ${PY_VER})..."
if pip3 install --quiet -r "${REQ_FILE}"; then
  echo "Python sidecar dependencies installed."
  exit 0
fi

echo "pip3 install failed; retrying with --user..." >&2
if pip3 install --user --quiet -r "${REQ_FILE}"; then
  echo "Python sidecar dependencies installed to user site."
  exit 0
fi

cat <<EOF >&2

Python sidecar dependency install failed.
This is non-fatal — the rest of setup will continue, but vector search
features (kvec embeddings) will be disabled until the sidecar is installed.

To finish manually, see SETUP.md Step 4 or run:
  pip3 install -r apps/api/requirements.txt
EOF
exit 0
