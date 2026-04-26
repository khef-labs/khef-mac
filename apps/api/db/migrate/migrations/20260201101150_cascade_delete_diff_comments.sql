-- Add trigger to cascade delete polymorphic comments when diffs are deleted
-- This handles CASCADE deletes from project deletion where app logic doesn't run

-- Function to delete comments before diff is deleted
CREATE OR REPLACE FUNCTION delete_diff_comments()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM comments WHERE entity_type = 'diff' AND entity_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Trigger to run before diff deletion
DROP TRIGGER IF EXISTS trigger_delete_diff_comments ON diffs;
CREATE TRIGGER trigger_delete_diff_comments
  BEFORE DELETE ON diffs
  FOR EACH ROW
  EXECUTE FUNCTION delete_diff_comments();

-- Clean up existing orphaned diff comments
DELETE FROM comments
WHERE entity_type = 'diff'
  AND NOT EXISTS (SELECT 1 FROM diffs WHERE id = comments.entity_id);

-- DOWN
-- DROP TRIGGER IF EXISTS trigger_delete_diff_comments ON diffs;
-- DROP FUNCTION IF EXISTS delete_diff_comments();
