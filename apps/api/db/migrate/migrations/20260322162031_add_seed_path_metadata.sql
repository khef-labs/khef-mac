-- Migration: Add Seed Path Metadata
-- Created: 2026-03-22T21:20:31.290Z

-- UP

INSERT INTO metadata (entity_type, field, description, value_type)
VALUES ('memory', 'seed-path', 'Relative path to the seed file on disk (from repo root)', 'string')
ON CONFLICT DO NOTHING;

-- DOWN

DELETE FROM memory_metadata WHERE metadata_id = (SELECT id FROM metadata WHERE entity_type = 'memory' AND field = 'seed-path');
DELETE FROM metadata WHERE entity_type = 'memory' AND field = 'seed-path';
