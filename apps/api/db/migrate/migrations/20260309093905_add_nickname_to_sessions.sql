-- Migration: Add Nickname To Sessions
-- Created: 2026-03-09T14:39:05.866Z

-- UP

ALTER TABLE sessions ADD COLUMN nickname VARCHAR(100);

-- Backfill from active_sessions where a nickname exists
UPDATE sessions s
SET nickname = a.nickname
FROM active_sessions a
WHERE s.session_id = a.session_id
  AND a.nickname IS NOT NULL;

-- DOWN

ALTER TABLE sessions DROP COLUMN IF EXISTS nickname;
