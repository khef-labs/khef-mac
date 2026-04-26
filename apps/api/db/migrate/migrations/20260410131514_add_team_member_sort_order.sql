-- Migration: Add sort_order to session_team_members for drag reorder persistence
-- Created: 2026-04-10T13:15:14Z

-- UP
ALTER TABLE session_team_members ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- Initialize sort_order based on added_at
WITH ranked AS (
  SELECT team_id, session_id, ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY added_at) - 1 AS rn
  FROM session_team_members
)
UPDATE session_team_members m
SET sort_order = r.rn
FROM ranked r
WHERE m.team_id = r.team_id AND m.session_id = r.session_id;

-- DOWN
ALTER TABLE session_team_members DROP COLUMN IF EXISTS sort_order;
