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

print_python_help() {
  cat <<EOF >&2
The kvec embedding sidecar needs Python ${MIN_PY}+.

Recommended (works on macOS 26 / Tahoe and avoids Homebrew bottle bugs):
  brew install pyenv
  pyenv install 3.12                       # latest 3.12.x
  pyenv local "\$(pyenv latest 3.12)"

Then re-run: npm run python:setup

See SETUP.md "Python version steering" for the full decision table.
EOF
}

if ! command -v python3 >/dev/null 2>&1; then
  echo "Skipping Python sidecar setup: python3 is not on PATH." >&2
  print_python_help
  exit 0
fi

PY_VER="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if ! python3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"; then
  echo "Skipping Python sidecar setup: python3 is ${PY_VER}, need ${MIN_PY}+." >&2
  print_python_help
  exit 0
fi

if ! command -v pip3 >/dev/null 2>&1; then
  echo "Skipping Python sidecar setup: pip3 is not on PATH." >&2
  echo "Install pip for python3, then run: npm run python:setup" >&2
  exit 0
fi

VENV_DIR="${ROOT_DIR}/apps/api/.venv"

install_into_venv() {
  echo "Creating project venv at apps/api/.venv (PEP 668 / externally-managed Python)..." >&2
  if ! python3 -m venv "${VENV_DIR}"; then
    echo "Failed to create venv at ${VENV_DIR}." >&2
    return 1
  fi
  if "${VENV_DIR}/bin/pip" install --quiet -r "${REQ_FILE}"; then
    echo "Python sidecar dependencies installed into apps/api/.venv."
    return 0
  fi
  return 1
}

echo "Installing Python sidecar dependencies (Python ${PY_VER})..."
PIP_OUT="$(pip3 install -r "${REQ_FILE}" 2>&1)"
PIP_STATUS=$?
if [[ ${PIP_STATUS} -eq 0 ]]; then
  echo "Python sidecar dependencies installed."
  exit 0
fi

if grep -q "externally-managed-environment" <<<"${PIP_OUT}"; then
  if install_into_venv; then
    exit 0
  fi
else
  echo "${PIP_OUT}" >&2
fi

cat <<EOF >&2

Python sidecar dependency install failed.
This is non-fatal — the rest of setup will continue, but vector search
features (kvec embeddings) will be disabled until the sidecar is installed.

To finish manually:
  python3 -m venv apps/api/.venv
  apps/api/.venv/bin/pip install -r apps/api/requirements.txt

Or see SETUP.md Step 4 / "Python version steering".
EOF
exit 0
