-- Migration: Add sub-collections and view mode to collections
-- Adds parent_id for single-level nesting and view_mode (list, board, grid)
-- for rendering collections as kanban boards or other layouts.

-- UP

-- =============================================================================
-- 1. Add parent_id and view_mode columns
-- =============================================================================
ALTER TABLE collections
  ADD COLUMN parent_id UUID REFERENCES collections(id) ON DELETE CASCADE,
  ADD COLUMN view_mode VARCHAR(20) NOT NULL DEFAULT 'list';

CREATE INDEX idx_collections_parent ON collections(parent_id);

-- =============================================================================
-- 2. Enforce single-level nesting (sub-collections cannot have children)
-- =============================================================================
CREATE OR REPLACE FUNCTION enforce_collection_single_level_nesting()
RETURNS TRIGGER AS $$
BEGIN
  -- If this collection has a parent, ensure the parent is a root collection
  IF NEW.parent_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM collections WHERE id = NEW.parent_id AND parent_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Sub-collections cannot have children (single-level nesting only)';
  END IF;

  -- If this is a root collection, ensure it has no children being re-parented under a parent
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS NOT NULL AND OLD.parent_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM collections WHERE parent_id = NEW.id) THEN
      RAISE EXCEPTION 'Cannot make a parent collection into a sub-collection while it has children';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_collection_single_level_nesting
  BEFORE INSERT OR UPDATE ON collections
  FOR EACH ROW
  EXECUTE FUNCTION enforce_collection_single_level_nesting();

-- =============================================================================
-- 3. Enforce sub-collection inherits parent project_id
-- =============================================================================
CREATE OR REPLACE FUNCTION enforce_collection_project_inheritance()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    NEW.project_id := (SELECT project_id FROM collections WHERE id = NEW.parent_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_collection_project_inheritance
  BEFORE INSERT OR UPDATE ON collections
  FOR EACH ROW
  EXECUTE FUNCTION enforce_collection_project_inheritance();

-- DOWN

DROP TRIGGER IF EXISTS trg_collection_project_inheritance ON collections;
DROP FUNCTION IF EXISTS enforce_collection_project_inheritance();
DROP TRIGGER IF EXISTS trg_collection_single_level_nesting ON collections;
DROP FUNCTION IF EXISTS enforce_collection_single_level_nesting();
DROP INDEX IF EXISTS idx_collections_parent;
ALTER TABLE collections DROP COLUMN IF EXISTS view_mode;
ALTER TABLE collections DROP COLUMN IF EXISTS parent_id;
