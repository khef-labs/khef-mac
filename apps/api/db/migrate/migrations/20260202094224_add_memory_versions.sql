-- Migration: Add memory version history
-- Allows tracking content snapshots over time, similar to plan versions

-- Add version tracking to memories
ALTER TABLE memories ADD COLUMN IF NOT EXISTS current_version INT DEFAULT 1;

-- Immutable content snapshots
CREATE TABLE IF NOT EXISTS memory_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version INT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source VARCHAR(50),           -- 'manual', 'external-sync', 'import', etc.
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(memory_id, version)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_memory_versions_memory ON memory_versions(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_versions_hash ON memory_versions(content_hash);

-- DOWN

DROP INDEX IF EXISTS idx_memory_versions_hash;
DROP INDEX IF EXISTS idx_memory_versions_memory;
DROP TABLE IF EXISTS memory_versions;
ALTER TABLE memories DROP COLUMN IF EXISTS current_version;
