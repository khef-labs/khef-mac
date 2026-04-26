-- Migration: Add comment author and replies support
-- Created: 2026-01-30T22:19:04.000Z

-- UP

-- Add author column for tracking who created the comment
-- 'user' = human, or assistant handle like 'claude-code', 'codex-cli'
ALTER TABLE comments
  ADD COLUMN author VARCHAR(50) NOT NULL DEFAULT 'user';

-- Add parent_comment_id for reply threading (1 level nesting only, enforced in API)
ALTER TABLE comments
  ADD COLUMN parent_comment_id UUID REFERENCES comments(id) ON DELETE CASCADE;

-- Index for efficient reply lookups
CREATE INDEX idx_comments_parent ON comments(parent_comment_id);

-- DOWN

DROP INDEX IF EXISTS idx_comments_parent;
ALTER TABLE comments DROP COLUMN IF EXISTS parent_comment_id;
ALTER TABLE comments DROP COLUMN IF EXISTS author;
