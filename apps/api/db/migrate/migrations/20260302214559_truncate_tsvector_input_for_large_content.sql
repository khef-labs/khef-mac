-- Migration: Truncate tsvector input to prevent overflow on large memories
-- Created: 2026-03-02T21:45:59Z
--
-- PostgreSQL tsvector has a hard limit of 1,048,575 bytes (~1MB).
-- The generated column ran to_tsvector on the full content, which fails
-- for large documents (e.g. synced Google Docs). Capping at 500K chars
-- prevents the overflow while memory_chunks.content_tsv still covers
-- the full text for search.

-- UP
ALTER TABLE memories DROP COLUMN content_tsv;
ALTER TABLE memories ADD COLUMN content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', LEFT(content, 500000))) STORED;
CREATE INDEX IF NOT EXISTS idx_memories_content_tsv ON memories USING GIN(content_tsv);

-- DOWN
DROP INDEX IF EXISTS idx_memories_content_tsv;
ALTER TABLE memories DROP COLUMN content_tsv;
ALTER TABLE memories ADD COLUMN content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX IF NOT EXISTS idx_memories_content_tsv ON memories USING GIN(content_tsv);
