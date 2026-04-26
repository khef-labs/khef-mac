-- Add soft delete support for diffs
-- Only one active (non-deleted) working tree diff per project

ALTER TABLE diffs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Ensure only one active working tree diff per project
CREATE UNIQUE INDEX IF NOT EXISTS idx_diffs_one_active_working_per_project
  ON diffs (project_id)
  WHERE commit_sha IS NULL AND deleted_at IS NULL;

-- DOWN

DROP INDEX IF EXISTS idx_diffs_one_active_working_per_project;
ALTER TABLE diffs DROP COLUMN IF EXISTS deleted_at;
