-- Migration: Allow null project_id on files for Gemini-generated content
-- Conversations may not be associated with a project

-- UP
ALTER TABLE files ALTER COLUMN project_id DROP NOT NULL;

-- DOWN
-- Backfill any nulls before re-adding constraint
DELETE FROM files WHERE project_id IS NULL;
ALTER TABLE files ALTER COLUMN project_id SET NOT NULL;
