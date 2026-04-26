-- Migration: Add subtypes under google-doc parent type
-- Children inherit statuses from google-doc parent (synced, unlinked, outdated)

-- UP

INSERT INTO memory_types (name, description, parent_id)
SELECT v.name, v.description, mt.id
FROM memory_types mt
CROSS JOIN (VALUES
  ('meeting-notes', 'Meeting agendas, minutes, and action items'),
  ('spec', 'Technical specifications and requirements documents'),
  ('prd', 'Product requirements documents'),
  ('proposal', 'Project proposals and RFCs'),
  ('report', 'Status reports, research reports, and analyses'),
  ('template', 'Reusable document templates'),
  ('note', 'General notes imported from Google Docs'),
  ('reference', 'Reference material imported from Google Docs')
) AS v(name, description)
WHERE mt.name = 'google-doc'
ON CONFLICT DO NOTHING;

-- DOWN

DELETE FROM memory_types
WHERE parent_id = (SELECT id FROM memory_types WHERE name = 'google-doc')
  AND name IN ('meeting-notes', 'spec', 'prd', 'proposal', 'report', 'template', 'note', 'reference');
