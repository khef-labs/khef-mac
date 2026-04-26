-- Migration: Add diagram memory type
-- Adds a new memory type for storing diagrams with draft/published/archived statuses

-- Step 1: Add diagram memory type
INSERT INTO memory_types (name, description) VALUES
  ('diagram', 'Visual diagrams, flowcharts, architecture drawings, and other visual documentation')
ON CONFLICT (name) DO NOTHING;

-- Step 2: Add statuses for diagram type
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, v.status_value, v.display_name, v.description, v.sort_order
FROM memory_types mt
CROSS JOIN (VALUES
  ('diagram', 'draft', 'Draft', 'Work in progress diagram', 0),
  ('diagram', 'published', 'Published', 'Finalized and published diagram', 1),
  ('diagram', 'archived', 'Archived', 'No longer current, kept for reference', 2)
) AS v(type_name, status_value, display_name, description, sort_order)
WHERE mt.name = v.type_name
ON CONFLICT (memory_type_id, status_value) DO NOTHING;

-- DOWN

-- Remove diagram statuses
DELETE FROM memory_type_statuses
WHERE memory_type_id = (SELECT id FROM memory_types WHERE name = 'diagram');

-- Remove diagram memory type
DELETE FROM memory_types WHERE name = 'diagram';
