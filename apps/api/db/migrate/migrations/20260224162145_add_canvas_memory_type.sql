-- Migration: Add canvas memory type hierarchy
-- Adds canvas parent type with widget, animation, prototype, and quiz children
-- for interactive HTML/JS/CSS content rendered in sandboxed iframes

-- UP

-- Step 1: Add canvas parent type
INSERT INTO memory_types (name, description) VALUES
  ('canvas', 'Interactive HTML/JS/CSS content rendered in a sandboxed iframe');

-- Step 2: Add statuses for canvas type
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, v.status_value, v.display_name, v.description, v.sort_order
FROM memory_types mt
CROSS JOIN (VALUES
  ('canvas', 'draft', 'Draft', 'Work in progress', 0),
  ('canvas', 'published', 'Published', 'Finalized and shareable', 1),
  ('canvas', 'archived', 'Archived', 'No longer current', 2)
) AS v(type_name, status_value, display_name, description, sort_order)
WHERE mt.name = v.type_name;

-- Step 3: Add child types
INSERT INTO memory_types (name, description, parent_id)
SELECT v.name, v.description, mt.id
FROM memory_types mt
CROSS JOIN (VALUES
  ('widget', 'Self-contained interactive components (visualizers, calculators, dashboards)'),
  ('animation', 'Animated visual content (motion graphics, illustrative animations)'),
  ('prototype', 'UI experiments, mockups, or design explorations'),
  ('quiz', 'Interactive quizzes and assessments')
) AS v(name, description)
WHERE mt.name = 'canvas';

-- DOWN

-- Remove child types
DELETE FROM memory_types WHERE parent_id = (SELECT id FROM memory_types WHERE name = 'canvas');

-- Remove canvas statuses
DELETE FROM memory_type_statuses
WHERE memory_type_id = (SELECT id FROM memory_types WHERE name = 'canvas');

-- Remove canvas parent type
DELETE FROM memory_types WHERE name = 'canvas';
