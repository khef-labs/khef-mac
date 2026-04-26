-- Migration: Add memory handle
-- Created: 2026-01-09T16:45:00.000Z

-- UP

-- Add handle column (nullable initially to allow backfill)
ALTER TABLE memories ADD COLUMN IF NOT EXISTS handle VARCHAR(255);

-- Backfill existing memories with per-project sequential handles: mem-1, mem-2, ... ordered by created_at
WITH seq AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at) AS rn
  FROM memories
  WHERE handle IS NULL OR handle = ''
)
UPDATE memories AS m
SET handle = 'mem-' || seq.rn::TEXT
FROM seq
WHERE m.id = seq.id AND (m.handle IS NULL OR m.handle = '');

-- Enforce format and uniqueness after backfill
ALTER TABLE memories
  ADD CONSTRAINT memories_handle_format CHECK (handle ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');

ALTER TABLE memories
  ALTER COLUMN handle SET NOT NULL;

ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS memories_project_handle_key;
ALTER TABLE memories
  ADD CONSTRAINT memories_project_handle_key UNIQUE (project_id, handle);


-- DOWN

-- Drop constraints then column
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_project_handle_key;
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_handle_format;
ALTER TABLE memories DROP COLUMN IF EXISTS handle;

