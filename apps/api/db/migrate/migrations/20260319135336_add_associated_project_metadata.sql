-- Migration: Add Associated Project Metadata
-- Created: 2026-03-19T18:53:36.844Z

-- UP

INSERT INTO metadata (entity_type, field, description, value_type)
VALUES
  ('memory', 'associated-project', 'Project handle this memory is associated with (overrides actual project)', 'string')
ON CONFLICT (entity_type, field) DO NOTHING;

-- DOWN

DELETE FROM memory_metadata
WHERE metadata_id = (SELECT id FROM metadata WHERE entity_type = 'memory' AND field = 'associated-project');

DELETE FROM metadata WHERE entity_type = 'memory' AND field = 'associated-project';
