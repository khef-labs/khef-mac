-- Add diff-specific anchor fields for comments
-- anchor_path: file path in the diff (e.g., "src/routes/git.ts")
-- anchor_line: line index in the diff (diff-relative position)

ALTER TABLE comments ADD COLUMN anchor_path VARCHAR(500);
ALTER TABLE comments ADD COLUMN anchor_line INTEGER;

COMMENT ON COLUMN comments.anchor_path IS 'File path for diff comments (e.g., src/routes/git.ts)';
COMMENT ON COLUMN comments.anchor_line IS 'Line index in the diff for diff comments';

-- DOWN

ALTER TABLE comments DROP COLUMN IF EXISTS anchor_path;
ALTER TABLE comments DROP COLUMN IF EXISTS anchor_line;
