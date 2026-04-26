-- Migration: Add google-doc as a built-in parent type
-- Users create custom subtypes (e.g., google-doc-note) via the custom types interface

-- UP

-- Insert google-doc parent type
INSERT INTO memory_types (name, description, built_in)
VALUES ('google-doc', 'Imported Google Docs with optional sync', TRUE)
ON CONFLICT (name) DO NOTHING;

-- Add statuses for google-doc parent (inherited by children)
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, v.status_value, v.display_name, v.description, v.sort_order
FROM memory_types mt
CROSS JOIN (VALUES
  ('synced', 'Synced', 'Content synced from Google Docs', 0),
  ('unlinked', 'Unlinked', 'No longer linked to source document', 1),
  ('outdated', 'Outdated', 'Source document may have changed', 2)
) AS v(status_value, display_name, description, sort_order)
WHERE mt.name = 'google-doc'
ON CONFLICT (memory_type_id, status_value) DO NOTHING;

-- DOWN
DELETE FROM memory_type_statuses WHERE memory_type_id = (SELECT id FROM memory_types WHERE name = 'google-doc');
DELETE FROM memory_types WHERE name = 'google-doc';
