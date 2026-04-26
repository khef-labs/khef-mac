#!/usr/bin/env bash
# Hard-kill stuck khef dev processes (API server, embed server, tsx watchers)

set -a
if [ -f "$(dirname "$0")/../.env" ]; then
  source "$(dirname "$0")/../.env" 2>/dev/null || true
fi
set +a

API_PORT="${PORT:-3200}"
EMBED_PORT="${EMBED_PORT:-9100}"
LOCK_FILE="/tmp/khef-dev-all.lock"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"

killed=0

# Kill dev:all wrapper process tree first (prevents respawning)
if [ -f "$LOCK_FILE" ]; then
  wrapper_pid=$(cat "$LOCK_FILE" 2>/dev/null || true)
  if [ -n "$wrapper_pid" ] && kill -0 "$wrapper_pid" 2>/dev/null; then
    echo "Killing dev:all wrapper (pid $wrapper_pid) and children"
    pkill -9 -P "$wrapper_pid" 2>/dev/null || true
    kill -9 "$wrapper_pid" 2>/dev/null || true
    killed=1
  fi
  rm -f "$LOCK_FILE"
fi

# Kill anything holding the ports
for port in "$API_PORT" "$EMBED_PORT"; do
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "Killing processes on port $port: $pids"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    killed=1
  fi
done

# Kill any node process running khef API (catches instances on non-standard ports)
api_procs=$(pgrep -f "$REPO_DIR/apps/api/node_modules/tsx.*src/index.ts" 2>/dev/null || true)
if [ -n "$api_procs" ]; then
  echo "Killing khef API processes: $api_procs"
  echo "$api_procs" | xargs kill -9 2>/dev/null || true
  killed=1
fi

# Kill orphaned tsx watchers and dev-all scripts for this project
orphans=$(pgrep -f "tsx watch $PROJECT_DIR/src/index.ts|tsx watch src/index.ts|dev-all.sh" 2>/dev/null || true)
if [ -n "$orphans" ]; then
  echo "Killing orphaned processes: $orphans"
  echo "$orphans" | xargs kill -9 2>/dev/null || true
  killed=1
fi

# Kill orphaned embed servers for this project
embed_orphans=$(pgrep -f "$PROJECT_DIR/src/services/vector/embed_server.py" 2>/dev/null || true)
if [ -n "$embed_orphans" ]; then
  echo "Killing orphaned embed servers: $embed_orphans"
  echo "$embed_orphans" | xargs kill -9 2>/dev/null || true
  killed=1
fi

# Kill UI dev server (Vite) and its esbuild child
ui_procs=$(pgrep -f "$REPO_DIR/apps/ui/node_modules/.bin/vite|$REPO_DIR/apps/ui/node_modules/@esbuild" 2>/dev/null || true)
if [ -n "$ui_procs" ]; then
  echo "Killing khef UI processes: $ui_procs"
  echo "$ui_procs" | xargs kill -9 2>/dev/null || true
  killed=1
fi

if [ "$killed" -eq 0 ]; then
  echo "No khef processes found"
else
  echo "Done"
fi
