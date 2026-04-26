-- Migration: Add csv memory type
-- Adds a new memory type for storing tabular data as CSV with spreadsheet rendering

-- UP

-- Step 1: Add csv memory type
INSERT INTO memory_types (name, description) VALUES
  ('csv', 'Tabular data stored as CSV with spreadsheet rendering');

-- Step 2: Add statuses for csv type
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, v.status_value, v.display_name, v.description, v.sort_order
FROM memory_types mt
CROSS JOIN (VALUES
  ('csv', 'draft', 'Draft', 'Work in progress', 0),
  ('csv', 'published', 'Published', 'Finalized dataset', 1),
  ('csv', 'archived', 'Archived', 'No longer current', 2)
) AS v(type_name, status_value, display_name, description, sort_order)
WHERE mt.name = v.type_name;

-- DOWN

-- Remove csv statuses
DELETE FROM memory_type_statuses
WHERE memory_type_id = (SELECT id FROM memory_types WHERE name = 'csv');

-- Remove csv memory type
DELETE FROM memory_types WHERE name = 'csv';
