#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)/db/backups}"

BACKUP_FILES=$(ls "$BACKUP_DIR"/khef_*.sql.gz "$BACKUP_DIR"/khef_*.sql 2>/dev/null || true)
if [ ! -d "$BACKUP_DIR" ] || [ -z "$BACKUP_FILES" ]; then
  echo "No backups found in $BACKUP_DIR"
  exit 0
fi

echo ""
echo "Backups in $BACKUP_DIR:"
echo ""

ls -lt "$BACKUP_DIR"/khef_*.sql.gz "$BACKUP_DIR"/khef_*.sql 2>/dev/null | awk '{printf "  %-10s %s %s %s  %s\n", $5, $6, $7, $8, $9}' | while read -r line; do
  # Extract size and path
  SIZE=$(echo "$line" | awk '{print $1}')
  FILE=$(echo "$line" | awk '{print $NF}')
  BASENAME=$(basename "$FILE")

  # Human-readable size
  if [ "$SIZE" -ge 1048576 ]; then
    HR_SIZE=$(awk "BEGIN {printf \"%.1fM\", $SIZE/1048576}")
  elif [ "$SIZE" -ge 1024 ]; then
    HR_SIZE=$(awk "BEGIN {printf \"%.1fK\", $SIZE/1024}")
  else
    HR_SIZE="${SIZE}B"
  fi

  printf "  %-40s %8s\n" "$BASENAME" "$HR_SIZE"
done

echo ""
COUNT=$(ls "$BACKUP_DIR"/khef_*.sql.gz "$BACKUP_DIR"/khef_*.sql 2>/dev/null | wc -l | tr -d ' ')
echo "  $COUNT backup(s) total"
echo ""
