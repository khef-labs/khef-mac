#!/usr/bin/env bash
#
# wait-for-api: Poll the khef API /health endpoint until it responds OK.
#
# Used by `npm run refresh` between install:all and db:seed:sync so that
# transient API downtime (tsx watch bouncing after node_modules changes) does
# not break the seed step.
#
# Usage:
#   bash scripts/wait-for-api.sh           # wait up to 30s, default port
#   KHEF_API_URL=http://localhost:3201 bash scripts/wait-for-api.sh
#   WAIT_TIMEOUT=60 bash scripts/wait-for-api.sh

set -euo pipefail

API_BASE="${KHEF_API_URL:-http://localhost:${PORT:-3201}}"
TIMEOUT="${WAIT_TIMEOUT:-30}"
INTERVAL="${WAIT_INTERVAL:-1}"

echo "Waiting for API at $API_BASE/health (timeout ${TIMEOUT}s)..."

elapsed=0
while [ "$elapsed" -lt "$TIMEOUT" ]; do
  if curl -sf "$API_BASE/health" > /dev/null 2>&1; then
    echo "API is ready."
    exit 0
  fi
  sleep "$INTERVAL"
  elapsed=$((elapsed + INTERVAL))
done

echo "Error: API did not become healthy at $API_BASE within ${TIMEOUT}s."
echo "Start the API first: npm run dev:api"
exit 1
