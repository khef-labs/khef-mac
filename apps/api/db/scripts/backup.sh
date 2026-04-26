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

# Resolve backup dir: env override > DB setting > default
if [ -z "${BACKUP_DIR:-}" ]; then
  if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" 2>/dev/null; then
    DB_SETTING=$(docker exec "$CONTAINER" \
      psql -U "$DB_USER" -d "$DB_NAME" -tAq \
      -c "SELECT value FROM settings WHERE key = 'backup.location'" 2>/dev/null || true)
    if [ -n "$DB_SETTING" ]; then
      # Resolve relative paths from PROJECT_ROOT
      if [[ "$DB_SETTING" = /* ]]; then
        BACKUP_DIR="$DB_SETTING"
      else
        BACKUP_DIR="$PROJECT_ROOT/$DB_SETTING"
      fi
    fi
  fi
  BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/db/backups}"
fi

# Verify container is running
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Error: container '$CONTAINER' is not running" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="khef_${TIMESTAMP}.sql.gz"
FILEPATH="$BACKUP_DIR/$FILENAME"

echo "Backing up '$DB_NAME' from container '$CONTAINER'..."
echo "  (excluding kvec.chunks — vectors are regenerable)"

docker exec "$CONTAINER" \
  pg_dump -U "$DB_USER" --no-owner --no-acl \
  --exclude-table-data='kvec.chunks' \
  "$DB_NAME" \
  | gzip > "$FILEPATH"

SIZE=$(du -h "$FILEPATH" | cut -f1)
echo "Backup saved: $FILEPATH ($SIZE)"

# Rotate: keep only the 5 most recent backups
MAX_BACKUPS=5
BACKUPS=( $(ls -1t "$BACKUP_DIR"/khef_*.sql.gz "$BACKUP_DIR"/khef_*.sql 2>/dev/null || true) )
COUNT=${#BACKUPS[@]}

if [ "$COUNT" -gt "$MAX_BACKUPS" ]; then
  EXCESS=$(( COUNT - MAX_BACKUPS ))
  echo "Warning: $COUNT backups found (max $MAX_BACKUPS). Deleting $EXCESS oldest:"
  for (( i=MAX_BACKUPS; i<COUNT; i++ )); do
    echo "  Removing: $(basename "${BACKUPS[$i]}")"
    rm -f "${BACKUPS[$i]}"
  done
fi
