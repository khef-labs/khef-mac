-- Migration: Add is-pinned metadata field for memories
-- Allows memories to be pinned so they surface in lists and session context

-- UP

INSERT INTO metadata (entity_type, field, description, value_type, default_value)
VALUES ('memory', 'is-pinned', 'Pin memory to surface it in lists and session context', 'boolean', 'false')
ON CONFLICT (entity_type, field) DO NOTHING;

-- DOWN

DELETE FROM memory_metadata WHERE metadata_id = (SELECT id FROM metadata WHERE entity_type = 'memory' AND field = 'is-pinned');
DELETE FROM metadata WHERE entity_type = 'memory' AND field = 'is-pinned';
