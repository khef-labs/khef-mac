-- Migration: Add token usage columns to sessions table
-- Created: 2026-03-27T20:51:03Z

-- UP
ALTER TABLE sessions
  ADD COLUMN model VARCHAR(100),
  ADD COLUMN total_input_tokens BIGINT DEFAULT 0,
  ADD COLUMN total_output_tokens BIGINT DEFAULT 0,
  ADD COLUMN total_cache_creation_tokens BIGINT DEFAULT 0,
  ADD COLUMN total_cache_read_tokens BIGINT DEFAULT 0;

-- DOWN
ALTER TABLE sessions
  DROP COLUMN IF EXISTS model,
  DROP COLUMN IF EXISTS total_input_tokens,
  DROP COLUMN IF EXISTS total_output_tokens,
  DROP COLUMN IF EXISTS total_cache_creation_tokens,
  DROP COLUMN IF EXISTS total_cache_read_tokens;
