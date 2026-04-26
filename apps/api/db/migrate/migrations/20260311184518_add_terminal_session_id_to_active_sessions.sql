-- Migration: Add terminal_session_id to active_sessions
-- Created: 2026-03-11T18:45:18Z

-- UP
ALTER TABLE active_sessions ADD COLUMN terminal_session_id varchar(64);

-- DOWN
ALTER TABLE active_sessions DROP COLUMN terminal_session_id;
