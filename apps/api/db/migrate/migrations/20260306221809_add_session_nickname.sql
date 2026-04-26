-- Migration: Add nickname column to active_sessions
-- Created: 2026-03-06T22:18:09Z

-- UP
ALTER TABLE active_sessions ADD COLUMN nickname VARCHAR(30);
CREATE UNIQUE INDEX idx_active_sessions_nickname ON active_sessions (nickname) WHERE nickname IS NOT NULL;

-- DOWN
DROP INDEX IF EXISTS idx_active_sessions_nickname;
ALTER TABLE active_sessions DROP COLUMN IF EXISTS nickname;
