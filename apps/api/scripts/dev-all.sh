#!/usr/bin/env bash

set -e

set -a
if [ -f .env ]; then
  # shellcheck disable=SC1091
  source .env 2>/dev/null || true
fi
set +a

PIDS=()
API_PID=""
EMBED_PID=""
FORCE_RESTART=1
EMBED_SKIP=0
LOCK_FILE="/tmp/khef-dev-all.lock"

for arg in "$@"; do
  case "$arg" in
    --force-restart)
      FORCE_RESTART=1
      ;;
    --no-force)
      FORCE_RESTART=0
      ;;
  esac
done

if [ -f "$LOCK_FILE" ]; then
  existing_pid=$(cat "$LOCK_FILE" 2>/dev/null || true)
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    if [ "$FORCE_RESTART" -eq 1 ]; then
      echo "[dev:all] stopping existing dev-all process ($existing_pid)"
      kill "$existing_pid" 2>/dev/null || true
      rm -f "$LOCK_FILE"
    else
      echo "[dev:all] dev-all already running (pid $existing_pid); use --no-force to keep it running"
      exit 1
    fi
  else
    rm -f "$LOCK_FILE"
  fi
fi

echo "$$" > "$LOCK_FILE"

# Prefer the project venv if setup-python.sh created one (PEP 668 / Homebrew).
# CWD here is apps/api when invoked via `npm run dev:api`.
if [ -x ".venv/bin/python3" ]; then
  EMBED_PYTHON=".venv/bin/python3"
else
  EMBED_PYTHON="python3"
fi

cleanup() {
  rm -f "$LOCK_FILE"
  for pid in "${PIDS[@]}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
}

trap cleanup INT TERM EXIT

if lsof -ti:9100 >/dev/null 2>&1; then
  if [ "$FORCE_RESTART" -eq 1 ]; then
    echo "[dev:all] stopping existing embed server on 9100"
    lsof -ti:9100 | xargs kill 2>/dev/null || true
    sleep 0.5
  else
    echo "[dev:all] embed server already running on 9100; use --force-restart to restart"
    EMBED_SKIP=1
  fi
fi

if lsof -ti:3200 >/dev/null 2>&1; then
  if [ "$FORCE_RESTART" -eq 1 ]; then
    echo "[dev:all] stopping existing API server on 3200"
    lsof -ti:3200 | xargs kill 2>/dev/null || true
  else
    echo "[dev:all] API server already running on 3200; use --force-restart to restart"
    exit 1
  fi
fi

if [ "$EMBED_SKIP" -eq 0 ]; then
  "$EMBED_PYTHON" src/services/vector/embed_server.py &
  EMBED_PID="$!"
  PIDS+=("$EMBED_PID")
fi

tsx watch --exclude '../../packages/kvec/**' src/index.ts &
API_PID="$!"
PIDS+=("$API_PID")

while true; do
  if [ "$EMBED_SKIP" -eq 0 ] && [ -n "$EMBED_PID" ]; then
    if ! kill -0 "$EMBED_PID" 2>/dev/null; then
      echo "[dev:all] embed server (pid $EMBED_PID) exited; respawning"
      "$EMBED_PYTHON" src/services/vector/embed_server.py &
      EMBED_PID="$!"
      PIDS+=("$EMBED_PID")
    fi
  fi

  if [ -n "$API_PID" ] && ! kill -0 "$API_PID" 2>/dev/null; then
    exit_code=0
    wait "$API_PID" || exit_code=$?
    cleanup
    exit "$exit_code"
  fi
  sleep 0.5
done
