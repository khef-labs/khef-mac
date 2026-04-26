-- Migration: Add Vector Settings
-- Created: 2026-01-28T22:14:42.917Z

-- UP

INSERT INTO settings (key, value, description, value_type) VALUES
  ('vector.enabled', 'false', 'Enable vector DB integration for semantic search', 'boolean'),
  ('vector.provider', 'chroma', 'Vector DB provider: chroma, qdrant, or pgvector', 'string'),
  ('vector.url', 'http://localhost:9000', 'Vector DB provider URL', 'string'),
  ('vector.collection', 'khef', 'Vector DB collection/index name', 'string'),
  ('vector.embeddingBackend', 'local', 'Embedding backend: local (sentence-transformers) or ollama', 'string'),
  ('vector.embeddingModel', 'all-mpnet-base-v2', 'Embedding model to use (backend-specific)', 'string')
ON CONFLICT (key) DO NOTHING;

-- DOWN

DELETE FROM settings WHERE key LIKE 'vector.%';
