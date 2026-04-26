#!/bin/bash
# Test environment manager for khef-ui e2e tests
# Usage: ./scripts/test-env.sh [up|down|status]

set -e

KHEF_DIR="${KHEF_DIR:-$HOME/projects/khef}"
TEST_API_PORT="${TEST_API_PORT:-3202}"
TEST_API_PID_FILE="/tmp/khef-test-api.pid"
TEST_API_LOG="/tmp/khef-test-api.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[test-env]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[test-env]${NC} $1"; }
log_error() { echo -e "${RED}[test-env]${NC} $1"; }

check_khef_dir() {
  if [ ! -d "$KHEF_DIR" ]; then
    log_error "khef directory not found at $KHEF_DIR"
    log_error "Set KHEF_DIR env var to the correct path"
    exit 1
  fi
}

start_test_db() {
  log_info "Starting test database..."
  cd "$KHEF_DIR"
  npm run test:db:up

  log_info "Waiting for test database to be healthy..."
  local retries=30
  while [ $retries -gt 0 ]; do
    if docker exec khef-test pg_isready -U postgres > /dev/null 2>&1; then
      log_info "Test database is ready"
      return 0
    fi
    retries=$((retries - 1))
    sleep 1
  done

  log_error "Test database failed to start"
  exit 1
}

run_migrations() {
  log_info "Running migrations on test database..."
  cd "$KHEF_DIR"

  # Source .env from apps/api/ to get TEST_DATABASE_URL
  set -a
  source apps/api/.env 2>/dev/null || true
  set +a

  # Drop all tables first to avoid "already exists" errors on re-runs
  # (matches setupTestDb() behavior in vitest)
  log_info "Dropping existing tables..."
  psql "$TEST_DATABASE_URL" -q -c "
    DROP SCHEMA IF EXISTS kdag CASCADE;
    DROP SCHEMA IF EXISTS kvec CASCADE;
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO postgres;
  " 2>/dev/null || true

  DATABASE_URL="$TEST_DATABASE_URL" npm run db:migrate
  log_info "Migrations complete"
}

start_test_api() {
  log_info "Starting test API server on port $TEST_API_PORT..."
  cd "$KHEF_DIR"

  # Source .env from apps/api/ to get TEST_DATABASE_URL
  set -a
  source apps/api/.env 2>/dev/null || true
  set +a

  # Start in background
  DATABASE_URL="$TEST_DATABASE_URL" PORT="$TEST_API_PORT" npm run dev > "$TEST_API_LOG" 2>&1 &
  echo $! > "$TEST_API_PID_FILE"

  log_info "Waiting for test API to be ready..."
  local retries=30
  while [ $retries -gt 0 ]; do
    if curl -s "http://localhost:$TEST_API_PORT/api/projects" > /dev/null 2>&1; then
      log_info "Test API is ready at http://localhost:$TEST_API_PORT"
      return 0
    fi
    retries=$((retries - 1))
    sleep 1
  done

  log_error "Test API failed to start. Check $TEST_API_LOG for details"
  exit 1
}

stop_test_api() {
  if [ -f "$TEST_API_PID_FILE" ]; then
    local pid=$(cat "$TEST_API_PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      log_info "Stopping test API (PID $pid)..."
      kill "$pid" 2>/dev/null || true
      # Wait a bit for graceful shutdown
      sleep 2
      # Force kill if still running
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$TEST_API_PID_FILE"
  fi
}

stop_test_db() {
  log_info "Stopping test database..."
  cd "$KHEF_DIR"
  npm run test:db:down 2>/dev/null || true
}

status() {
  echo ""
  log_info "Test Environment Status"
  echo "------------------------"

  # Check test DB
  if docker ps --format '{{.Names}}' | grep -q "khef-test"; then
    echo -e "Test DB:  ${GREEN}running${NC} (container: khef-test)"
  else
    echo -e "Test DB:  ${RED}stopped${NC}"
  fi

  # Check test API
  if [ -f "$TEST_API_PID_FILE" ] && kill -0 "$(cat $TEST_API_PID_FILE)" 2>/dev/null; then
    echo -e "Test API: ${GREEN}running${NC} (port: $TEST_API_PORT, pid: $(cat $TEST_API_PID_FILE))"
  else
    echo -e "Test API: ${RED}stopped${NC}"
  fi

  echo ""
}

case "${1:-}" in
  up)
    check_khef_dir
    stop_test_api  # Clean up any stale process
    start_test_db
    run_migrations
    start_test_api
    echo ""
    log_info "Test environment is ready!"
    log_info "Run tests with: npm run test:e2e"
    log_info "Stop with: npm run test:env:down"
    echo ""
    ;;
  down)
    check_khef_dir
    stop_test_api
    stop_test_db
    log_info "Test environment stopped"
    ;;
  status)
    status
    ;;
  *)
    echo "Usage: $0 [up|down|status]"
    echo ""
    echo "Commands:"
    echo "  up      Start test database and API server"
    echo "  down    Stop test database and API server"
    echo "  status  Show current status"
    echo ""
    echo "Environment variables:"
    echo "  KHEF_DIR     Path to khef project (default: ~/projects/khef)"
    echo "  TEST_API_PORT   Port for test API server (default: 3201)"
    exit 1
    ;;
esac
