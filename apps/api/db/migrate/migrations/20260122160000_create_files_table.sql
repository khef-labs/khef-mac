-- Migration: Create files table for image/file uploads
-- This migration:
-- 1. Creates files table to track uploaded files
-- 2. Adds storage path setting for file uploads

-- Step 1: Create files table
CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename VARCHAR(255) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 2: Create indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_files_project_id ON files(project_id);
CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at DESC);

-- Step 3: Add storage path setting
INSERT INTO settings (key, value, description, value_type) VALUES
  ('files.storagePath', './uploads', 'Base directory for file uploads', 'string'),
  ('files.maxSizeMb', '10', 'Maximum file size in MB', 'integer')
ON CONFLICT (key) DO NOTHING;

-- DOWN

-- Remove indexes
DROP INDEX IF EXISTS idx_files_created_at;
DROP INDEX IF EXISTS idx_files_project_id;

-- Drop table
DROP TABLE IF EXISTS files;

-- Remove settings
DELETE FROM settings WHERE key IN ('files.storagePath', 'files.maxSizeMb');
