-- Migration: Add current_snapshot pointer to dbx.saved_queries
-- Created: 2026-04-30T14:59:43.404Z
--
-- Mirrors memories.current_snapshot: a pointer to the snapshot whose SQL
-- matches the live row right now. Set on capture/restore. NULL when the
-- live SQL doesn't correspond to any snapshot (initial state, or after
-- editing without capturing). Allows the UI to surface a "#N current"
-- marker in the dropdown and to refuse deleting the matching snapshot.

-- UP

-- Plain integer pointer; correctness (referencing a real snapshot for the
-- same query_id) is enforced at the application layer rather than via FK,
-- since the natural key is composite (query_id, snapshot_number) and one
-- side is on the parent table.
ALTER TABLE dbx.saved_queries
  ADD COLUMN current_snapshot INTEGER;

-- Backfill: existing queries with snapshots → MAX(snapshot_number).
UPDATE dbx.saved_queries q
SET current_snapshot = sub.max_snap
FROM (
  SELECT query_id, MAX(snapshot_number) AS max_snap
  FROM dbx.saved_query_snapshots
  GROUP BY query_id
) sub
WHERE sub.query_id = q.id;

-- DOWN

ALTER TABLE dbx.saved_queries DROP COLUMN IF EXISTS current_snapshot;
