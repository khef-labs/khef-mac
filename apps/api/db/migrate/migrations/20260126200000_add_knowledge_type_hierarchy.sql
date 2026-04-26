-- Migration: Add knowledge type hierarchy with self-referential parent_id
-- Adds parent_id to memory_types for single-level nesting, creates 'knowledge'
-- as a parent type with 'commands', 'context', 'pattern' as children, migrates
-- existing standalone command/context/pattern memories, and removes old types.

-- UP

-- =============================================================================
-- 1. Add parent_id column to memory_types
-- =============================================================================
ALTER TABLE memory_types ADD COLUMN parent_id UUID REFERENCES memory_types(id);

-- =============================================================================
-- 2. Enforce single-level nesting (parent must be a root type)
-- =============================================================================
CREATE OR REPLACE FUNCTION enforce_single_level_nesting()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM memory_types WHERE id = NEW.parent_id AND parent_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Only single-level nesting allowed: parent must be a root type';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_single_level_nesting_trigger
  BEFORE INSERT OR UPDATE ON memory_types
  FOR EACH ROW
  EXECUTE FUNCTION enforce_single_level_nesting();

-- =============================================================================
-- 3. Insert knowledge parent type
-- =============================================================================
INSERT INTO memory_types (name, description)
VALUES ('knowledge', 'Project operational knowledge including commands, context, and patterns');

-- =============================================================================
-- 4. Insert child types with parent_id = knowledge
-- =============================================================================
INSERT INTO memory_types (name, description, parent_id)
SELECT v.name, v.description, mt.id
FROM memory_types mt
CROSS JOIN (VALUES
  ('commands', 'CLI commands, scripts, and operational procedures'),
  ('context-child', 'Background information, architecture, DB schema, env setup'),
  ('pattern-child', 'Recurring workflows, conventions, and best practices')
) AS v(name, description)
WHERE mt.name = 'knowledge';

-- =============================================================================
-- 5. Create statuses for child types (migrated from old standalone types)
-- =============================================================================

-- Commands statuses (from old 'command' type)
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, v.status_value, v.display_name, v.description, v.sort_order
FROM memory_types mt
CROSS JOIN (VALUES
  ('unverified', 'Unverified', 'Command not yet tested', 0),
  ('verified', 'Verified', 'Command tested and confirmed working', 1),
  ('deprecated', 'Deprecated', 'Command is outdated and should not be used', 2)
) AS v(status_value, display_name, description, sort_order)
WHERE mt.name = 'commands';

-- Context child statuses (from old 'context' type)
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, v.status_value, v.display_name, v.description, v.sort_order
FROM memory_types mt
CROSS JOIN (VALUES
  ('current', 'Current', 'Currently relevant', 0),
  ('outdated', 'Outdated', 'No longer current', 1),
  ('updated', 'Updated', 'Recently updated', 2)
) AS v(status_value, display_name, description, sort_order)
WHERE mt.name = 'context-child';

-- Pattern child statuses (from old 'pattern' type)
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, v.status_value, v.display_name, v.description, v.sort_order
FROM memory_types mt
CROSS JOIN (VALUES
  ('proposed', 'Proposed', 'Pattern proposed for adoption', 0),
  ('active', 'Active', 'Actively used pattern', 1),
  ('deprecated', 'Deprecated', 'No longer recommended', 2)
) AS v(status_value, display_name, description, sort_order)
WHERE mt.name = 'pattern-child';

-- Knowledge parent fallback statuses
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, v.status_value, v.display_name, v.description, v.sort_order
FROM memory_types mt
CROSS JOIN (VALUES
  ('current', 'Current', 'Currently relevant', 0),
  ('deprecated', 'Deprecated', 'No longer recommended', 1)
) AS v(status_value, display_name, description, sort_order)
WHERE mt.name = 'knowledge';

-- =============================================================================
-- 6. Replace validation trigger with parent-aware version
-- =============================================================================
CREATE OR REPLACE FUNCTION validate_memory_status_matches_type()
RETURNS TRIGGER AS $$
DECLARE v_parent_id UUID;
BEGIN
  SELECT parent_id INTO v_parent_id FROM memory_types WHERE id = NEW.memory_type_id;
  IF NOT EXISTS (
    SELECT 1 FROM memory_type_statuses mts
    WHERE mts.id = NEW.status_id
      AND (mts.memory_type_id = NEW.memory_type_id
           OR (v_parent_id IS NOT NULL AND mts.memory_type_id = v_parent_id))
  ) THEN
    RAISE EXCEPTION 'Status does not match memory type';
  END IF;
  IF (TG_OP = 'UPDATE' AND NEW.status_id IS DISTINCT FROM OLD.status_id)
     OR TG_OP = 'INSERT' THEN
    NEW.status_updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 7. Migrate existing command/context/pattern memories to child types
-- =============================================================================

-- Migrate command → commands
UPDATE memories SET
  memory_type_id = (SELECT id FROM memory_types WHERE name = 'commands'),
  status_id = COALESCE(
    -- Try to find matching status in new child type
    (SELECT ms.id FROM memory_type_statuses ms
     WHERE ms.memory_type_id = (SELECT id FROM memory_types WHERE name = 'commands')
       AND ms.status_value = (
         SELECT oms.status_value FROM memory_type_statuses oms
         WHERE oms.id = memories.status_id
       )),
    -- Fallback to child type default
    (SELECT ms.id FROM memory_type_statuses ms
     WHERE ms.memory_type_id = (SELECT id FROM memory_types WHERE name = 'commands')
     ORDER BY ms.sort_order LIMIT 1)
  )
WHERE memory_type_id = (SELECT id FROM memory_types WHERE name = 'command');

-- Migrate context → context-child
UPDATE memories SET
  memory_type_id = (SELECT id FROM memory_types WHERE name = 'context-child'),
  status_id = COALESCE(
    (SELECT ms.id FROM memory_type_statuses ms
     WHERE ms.memory_type_id = (SELECT id FROM memory_types WHERE name = 'context-child')
       AND ms.status_value = (
         SELECT oms.status_value FROM memory_type_statuses oms
         WHERE oms.id = memories.status_id
       )),
    (SELECT ms.id FROM memory_type_statuses ms
     WHERE ms.memory_type_id = (SELECT id FROM memory_types WHERE name = 'context-child')
     ORDER BY ms.sort_order LIMIT 1)
  )
WHERE memory_type_id = (SELECT id FROM memory_types WHERE name = 'context');

-- Migrate pattern → pattern-child
UPDATE memories SET
  memory_type_id = (SELECT id FROM memory_types WHERE name = 'pattern-child'),
  status_id = COALESCE(
    (SELECT ms.id FROM memory_type_statuses ms
     WHERE ms.memory_type_id = (SELECT id FROM memory_types WHERE name = 'pattern-child')
       AND ms.status_value = (
         SELECT oms.status_value FROM memory_type_statuses oms
         WHERE oms.id = memories.status_id
       )),
    (SELECT ms.id FROM memory_type_statuses ms
     WHERE ms.memory_type_id = (SELECT id FROM memory_types WHERE name = 'pattern-child')
     ORDER BY ms.sort_order LIMIT 1)
  )
WHERE memory_type_id = (SELECT id FROM memory_types WHERE name = 'pattern');

-- =============================================================================
-- 8. Remove old standalone types (cascades their statuses via FK)
-- =============================================================================
DELETE FROM memory_types WHERE name IN ('command', 'context', 'pattern');

-- =============================================================================
-- 9. Rename child types to their final names
-- =============================================================================
-- Now that the old types are gone, rename the child types
UPDATE memory_types SET name = 'context' WHERE name = 'context-child';
UPDATE memory_types SET name = 'pattern' WHERE name = 'pattern-child';

-- =============================================================================
-- 10. Add diagram type if missing (already exists from earlier migration)
-- =============================================================================
INSERT INTO memory_types (name, description)
VALUES ('diagram', 'Diagrams and visual representations')
ON CONFLICT (name) DO NOTHING;

-- DOWN

-- This migration is not safely reversible because data migration is destructive.
-- A manual rollback would require restoring command/context/pattern types as
-- standalone types and migrating data back from the knowledge hierarchy.
SELECT 'This migration cannot be automatically reversed' AS warning;
