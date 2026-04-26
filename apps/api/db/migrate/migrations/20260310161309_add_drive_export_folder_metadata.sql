-- Migration: Add per-memory drive export folder metadata field
-- Allows overriding the global drive.syncFolder setting on individual memories.

-- UP
INSERT INTO metadata (entity_type, field, description, value_type, default_value) VALUES
  ('memory', 'drive-export-folder', 'Override Google Drive export folder path for this memory', 'string', NULL)
ON CONFLICT (entity_type, field) DO NOTHING;

-- DOWN
DELETE FROM memory_metadata WHERE metadata_id IN (
  SELECT id FROM metadata WHERE entity_type = 'memory' AND field = 'drive-export-folder'
);
DELETE FROM metadata WHERE entity_type = 'memory' AND field = 'drive-export-folder';
