-- Migration: Add path column to projects table
-- Stores the filesystem path where the project is located (e.g., ~/projects/my-app)

ALTER TABLE projects ADD COLUMN path TEXT;

-- DOWN
ALTER TABLE projects DROP COLUMN path;
