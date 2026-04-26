-- Migration: Add memory_id to files for tracking memory-associated files (e.g., images from Google Docs)
-- Created: 2026-03-11T14:00:00.000Z

-- UP

ALTER TABLE files ADD COLUMN memory_id UUID REFERENCES memories(id) ON DELETE CASCADE;
CREATE INDEX idx_files_memory_id ON files (memory_id) WHERE memory_id IS NOT NULL;

-- DOWN

DROP INDEX IF EXISTS idx_files_memory_id;
ALTER TABLE files DROP COLUMN IF EXISTS memory_id;
