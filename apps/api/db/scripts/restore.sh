#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Load .env for container/db config
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
fi

CONTAINER="${POSTGRES_CONTAINER:-khef}"
DB_NAME="${POSTGRES_DB:-khef}"
DB_USER="${POSTGRES_USER:-postgres}"

# Verify container is running
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Error: container '$CONTAINER' is not running" >&2
  exit 1
fi

# Resolve backup dir: env override > DB setting > default
if [ -z "${BACKUP_DIR:-}" ]; then
  DB_SETTING=$(docker exec "$CONTAINER" \
    psql -U "$DB_USER" -d "$DB_NAME" -tAq \
    -c "SELECT value FROM settings WHERE key = 'backup.location'" 2>/dev/null || true)
  if [ -n "$DB_SETTING" ]; then
    if [[ "$DB_SETTING" = /* ]]; then
      BACKUP_DIR="$DB_SETTING"
    else
      BACKUP_DIR="$PROJECT_ROOT/$DB_SETTING"
    fi
  fi
  BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/db/backups}"
fi

# Determine which backup to restore
if [ $# -ge 1 ]; then
  # Argument provided: look for exact match or partial match in backups dir
  TARGET="$1"
  if [ -f "$TARGET" ]; then
    FILEPATH="$TARGET"
  elif [ -f "$BACKUP_DIR/$TARGET" ]; then
    FILEPATH="$BACKUP_DIR/$TARGET"
  else
    # Try glob match (.sql.gz first, then .sql)
    MATCH=$(ls -t "$BACKUP_DIR"/khef_*"$TARGET"*.sql.gz "$BACKUP_DIR"/khef_*"$TARGET"*.sql 2>/dev/null | head -1 || true)
    if [ -z "$MATCH" ]; then
      echo "Error: no backup matching '$TARGET' found in $BACKUP_DIR" >&2
      exit 1
    fi
    FILEPATH="$MATCH"
  fi
else
  # No argument: use most recent backup (.sql.gz or .sql)
  FILEPATH=$(ls -t "$BACKUP_DIR"/khef_*.sql.gz "$BACKUP_DIR"/khef_*.sql 2>/dev/null | head -1 || true)
  if [ -z "$FILEPATH" ]; then
    echo "Error: no backups found in $BACKUP_DIR" >&2
    exit 1
  fi
fi

FILENAME=$(basename "$FILEPATH")
SIZE=$(du -h "$FILEPATH" | cut -f1)

echo ""
echo "  Restore: $FILENAME ($SIZE)"
echo "  Target:  $DB_NAME @ $CONTAINER"
echo ""
echo "  WARNING: This will DROP and recreate the '$DB_NAME' database."
echo ""
read -rp "  Continue? [y/N] " CONFIRM

if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

echo ""
echo "Terminating existing connections to '$DB_NAME'..."

docker exec "$CONTAINER" \
  psql -U "$DB_USER" -d postgres -q \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();" \
  > /dev/null

echo "Dropping and recreating '$DB_NAME'..."

docker exec "$CONTAINER" \
  psql -U "$DB_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS \"$DB_NAME\";" \
  -c "CREATE DATABASE \"$DB_NAME\";"

echo "Restoring from $FILENAME..."

if [[ "$FILEPATH" == *.gz ]]; then
  gunzip -c "$FILEPATH" | docker exec -i "$CONTAINER" \
    psql -U "$DB_USER" -d "$DB_NAME" -q
else
  docker exec -i "$CONTAINER" \
    psql -U "$DB_USER" -d "$DB_NAME" -q \
    < "$FILEPATH"
fi

echo "Restore complete."
echo ""
echo "Note: kvec.chunks (vector embeddings) are excluded from backups."
echo "Re-embed with: npm run kvec:embed, or restart the API to trigger memory/session sync."
