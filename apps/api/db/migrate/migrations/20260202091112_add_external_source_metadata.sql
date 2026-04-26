-- Migration: Add external source metadata fields
-- Enables linking memories to external sources (Google Docs, Notion, etc.)

-- UP

INSERT INTO metadata (entity_type, field, description, value_type)
VALUES
  ('memory', 'external-source-type', 'External source type (google-doc, notion, etc.)', 'string'),
  ('memory', 'external-source-id', 'Document ID from external source', 'string'),
  ('memory', 'external-source-url', 'URL to original document', 'string'),
  ('memory', 'external-source-last-synced-at', 'Last sync timestamp (ISO 8601)', 'string')
ON CONFLICT (entity_type, field) DO NOTHING;

-- DOWN

DELETE FROM metadata
WHERE entity_type = 'memory'
AND field IN (
  'external-source-type',
  'external-source-id',
  'external-source-url',
  'external-source-last-synced-at'
);
