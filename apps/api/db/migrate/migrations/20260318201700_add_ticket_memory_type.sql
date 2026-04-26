-- Migration: Add ticket parent type with epic, story, spike, task children
-- Follows the same hierarchy pattern as knowledge and canvas.
-- Children inherit parent statuses: open, in_progress, blocked, done, canceled.

-- UP

-- =============================================================================
-- 1. Insert ticket parent type
-- =============================================================================
INSERT INTO memory_types (name, description, is_parent_type)
SELECT 'ticket', 'Board-oriented task cards with inline expand and checklist support', true
WHERE NOT EXISTS (SELECT 1 FROM memory_types WHERE name = 'ticket');

-- =============================================================================
-- 2. Insert child types
-- =============================================================================
INSERT INTO memory_types (name, description, parent_id)
SELECT v.name, v.description, mt.id
FROM memory_types mt
CROSS JOIN (VALUES
  ('epic', 'Large body of work containing multiple stories'),
  ('story', 'User-facing deliverable or feature'),
  ('spike', 'Timeboxed research or exploration task'),
  ('task', 'Generic work item')
) AS v(name, description)
WHERE mt.name = 'ticket'
  AND NOT EXISTS (
    SELECT 1 FROM memory_types WHERE name = v.name AND parent_id = mt.id
  );

-- =============================================================================
-- 3. Insert statuses on the parent (children inherit these)
-- =============================================================================
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, v.status_value, v.display_name, v.description, v.sort_order
FROM memory_types mt
CROSS JOIN (VALUES
  ('open', 'To Do', 'Not yet started', 0),
  ('in_progress', 'In Progress', 'Currently being worked on', 1),
  ('blocked', 'Blocked', 'Waiting on dependency or external input', 2),
  ('done', 'Done', 'Completed', 3),
  ('canceled', 'Canceled', 'Will not be done', 4)
) AS v(status_value, display_name, description, sort_order)
WHERE mt.name = 'ticket'
  AND NOT EXISTS (
    SELECT 1 FROM memory_type_statuses mts
    WHERE mts.memory_type_id = mt.id AND mts.status_value = v.status_value
  );

-- DOWN

-- Delete children first (FK constraint), then parent
DELETE FROM memory_type_statuses
WHERE memory_type_id IN (SELECT id FROM memory_types WHERE parent_id = (SELECT id FROM memory_types WHERE name = 'ticket'));

DELETE FROM memory_types
WHERE parent_id = (SELECT id FROM memory_types WHERE name = 'ticket');

DELETE FROM memory_type_statuses
WHERE memory_type_id = (SELECT id FROM memory_types WHERE name = 'ticket');

DELETE FROM memory_types WHERE name = 'ticket';
