-- Add favorite flag to projects
ALTER TABLE projects ADD COLUMN is_favorite BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index for quick favorite lookups
CREATE INDEX idx_projects_favorite ON projects(is_favorite) WHERE is_favorite = TRUE;

-- DOWN
DROP INDEX IF EXISTS idx_projects_favorite;
ALTER TABLE projects DROP COLUMN IF EXISTS is_favorite;
