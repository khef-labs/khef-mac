-- Migration: Allow Shared Nicknames
-- Created: 2026-03-11T11:49:06.409Z

-- UP
DROP INDEX IF EXISTS idx_active_sessions_nickname;
CREATE INDEX idx_active_sessions_nickname ON active_sessions (nickname) WHERE nickname IS NOT NULL;

-- DOWN
DROP INDEX IF EXISTS idx_active_sessions_nickname;
CREATE UNIQUE INDEX idx_active_sessions_nickname ON active_sessions (nickname) WHERE nickname IS NOT NULL;
