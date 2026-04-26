-- Minimal diffs table for attaching comments to git commits
-- Diff content is computed live from git; only metadata stored here

CREATE TABLE IF NOT EXISTS diffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch VARCHAR(255) NOT NULL,
  commit_sha VARCHAR(40),  -- NULL = working tree
  parent_sha VARCHAR(40),
  path VARCHAR(500),       -- optional: scope to specific files
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One record per project + commit + path combination
  UNIQUE(project_id, commit_sha, path)
);

CREATE INDEX IF NOT EXISTS idx_diffs_project ON diffs(project_id);
CREATE INDEX IF NOT EXISTS idx_diffs_commit ON diffs(commit_sha) WHERE commit_sha IS NOT NULL;

COMMENT ON TABLE diffs IS 'Minimal metadata for git diffs. Content computed live from git. Used to attach polymorphic comments to specific commits.';
COMMENT ON COLUMN diffs.commit_sha IS 'Commit SHA. NULL indicates working tree (uncommitted changes).';
COMMENT ON COLUMN diffs.parent_sha IS 'Parent commit SHA for diff comparison. Typically commit^1.';
COMMENT ON COLUMN diffs.path IS 'Optional path filter. When set, diff is scoped to this file/directory.';

-- DOWN

DROP TABLE IF EXISTS diffs;
