-- Migration: Add comments snapshot to memory versions
-- Stores a JSON snapshot of comments at the time of version creation

ALTER TABLE memory_versions
  ADD COLUMN IF NOT EXISTS comments_snapshot JSONB;

COMMENT ON COLUMN memory_versions.comments_snapshot IS 'JSON array of comment objects at time of snapshot';

-- DOWN

ALTER TABLE memory_versions DROP COLUMN IF EXISTS comments_snapshot;
