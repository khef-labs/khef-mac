-- Migration: Add Embedding Storage
-- Created: 2026-01-28T23:10:42.548Z
--
-- Store embeddings in PostgreSQL so we embed once and sync to any vector provider.
-- Uses pgvector extension for efficient vector storage and optional direct search.

-- UP

-- Enable pgvector extension (requires postgres with pgvector installed)
CREATE EXTENSION IF NOT EXISTS vector;

-- Store embeddings separately from memories to keep main table lean
CREATE TABLE memory_embeddings (
  memory_id UUID PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  embedding vector(768) NOT NULL,
  model_name VARCHAR(100) NOT NULL DEFAULT 'all-MiniLM-L6-v2',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for similarity search (if using pgvector directly)
CREATE INDEX memory_embeddings_vector_idx ON memory_embeddings
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Track which memories need embedding (NULL = needs embedding)
ALTER TABLE memories ADD COLUMN embedding_generated_at TIMESTAMPTZ;

-- DOWN

ALTER TABLE memories DROP COLUMN IF EXISTS embedding_generated_at;
DROP TABLE IF EXISTS memory_embeddings;
DROP EXTENSION IF EXISTS vector;
