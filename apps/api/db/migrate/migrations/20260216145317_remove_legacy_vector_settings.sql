-- Migration: Remove legacy vector DB settings (provider, url, collection, etc.)
-- These settings were for Chroma/Qdrant support, now replaced by kvec (pgvector).
-- Only vector.enabled is retained.
-- Created: 2026-02-16T14:53:17Z

-- UP
DELETE FROM settings WHERE key IN (
  'vector.provider',
  'vector.url',
  'vector.collection',
  'vector.embeddingBackend',
  'vector.embeddingModel',
  'vector.batchSize'
);

-- DOWN
INSERT INTO settings (key, value, description, value_type) VALUES
  ('vector.provider', 'pgvector', 'Vector DB provider: chroma, qdrant, or pgvector', 'string'),
  ('vector.url', 'http://localhost:9000', 'Vector DB provider URL', 'string'),
  ('vector.collection', 'khef', 'Vector DB collection/index name', 'string'),
  ('vector.embeddingBackend', 'local', 'Embedding backend: local (sentence-transformers) or ollama', 'string'),
  ('vector.embeddingModel', 'all-mpnet-base-v2', 'Embedding model to use (backend-specific)', 'string'),
  ('vector.batchSize', '50', 'Number of memories to process per sync cycle', 'integer')
ON CONFLICT (key) DO NOTHING;
