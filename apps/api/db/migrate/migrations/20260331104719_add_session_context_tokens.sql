-- Migration: Add context window usage tracking to sessions
-- Created: 2026-03-31T10:47:19Z

-- UP
ALTER TABLE sessions
  ADD COLUMN context_window_tokens BIGINT DEFAULT 0;

COMMENT ON COLUMN sessions.context_window_tokens IS 'Context fill from last assistant turn (input_tokens + cache_creation + cache_read)';

-- DOWN
ALTER TABLE sessions
  DROP COLUMN IF EXISTS context_window_tokens;
