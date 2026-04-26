-- Migration: Add chunk_count to session_summary_snapshots
-- Created: 2026-03-10T23:13:00.000Z

-- UP
ALTER TABLE session_summary_snapshots ADD COLUMN chunk_count integer;

-- Backfill existing snapshots with total chunk count at time of snapshot creation
UPDATE session_summary_snapshots sss
SET chunk_count = (
  SELECT COUNT(*)::integer FROM session_chunks sc WHERE sc.session_id = sss.session_id
);

-- DOWN
ALTER TABLE session_summary_snapshots DROP COLUMN chunk_count;
