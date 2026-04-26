-- Migration: Add slide-order metadata field for memories
-- Allows the UI to persist slide ordering for memory presentations

-- UP

INSERT INTO metadata (entity_type, field, description, value_type)
VALUES
  ('memory', 'slide-order', 'Comma-separated list of section headings defining slide order', 'string')
ON CONFLICT (entity_type, field) DO NOTHING;

-- DOWN

DELETE FROM metadata WHERE entity_type = 'memory' AND field = 'slide-order';
