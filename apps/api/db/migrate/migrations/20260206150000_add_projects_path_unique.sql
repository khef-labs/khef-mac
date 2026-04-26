-- Migration: Add unique constraint on projects.path
-- Prevents multiple projects from having the same filesystem path

-- UP
-- Use a partial unique index since path can be NULL
CREATE UNIQUE INDEX projects_path_unique ON projects (path) WHERE path IS NOT NULL;

-- DOWN
DROP INDEX IF EXISTS projects_path_unique;
