-- Ensure commit_sha is either NULL (working tree) or exactly 40 chars (full SHA)

-- First, delete any invalid records (short SHAs)
DELETE FROM comments
WHERE entity_type = 'diff'
  AND entity_id IN (SELECT id FROM diffs WHERE commit_sha IS NOT NULL AND LENGTH(commit_sha) != 40);

DELETE FROM diffs WHERE commit_sha IS NOT NULL AND LENGTH(commit_sha) != 40;

-- Add the constraint (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_commit_sha_length'
  ) THEN
    ALTER TABLE diffs ADD CONSTRAINT chk_commit_sha_length
      CHECK (commit_sha IS NULL OR LENGTH(commit_sha) = 40);
  END IF;
END $$;

-- DOWN

ALTER TABLE diffs DROP CONSTRAINT IF EXISTS chk_commit_sha_length;
