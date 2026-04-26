-- Migration: add_vector_sync
-- Created: 2026-01-28T15:23:25.000Z
-- Description: Add vector sync tracking for semantic search integration

-- UP
-- Track when memories were last synced to vector DB
ALTER TABLE memories ADD COLUMN vector_synced_at TIMESTAMPTZ;

-- Index for efficient querying of unsynced memories
CREATE INDEX idx_memories_vector_sync ON memories (updated_at, vector_synced_at)
WHERE vector_synced_at IS NULL OR vector_synced_at < updated_at;

-- Queue for tracking deleted memory IDs (needed since we can't query PG for deleted records)
CREATE TABLE vector_delete_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  memory_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient batch processing
CREATE INDEX idx_vector_delete_queue_created ON vector_delete_queue (created_at);

-- DOWN
DROP TABLE IF EXISTS vector_delete_queue;
DROP INDEX IF EXISTS idx_memories_vector_sync;
ALTER TABLE memories DROP COLUMN IF EXISTS vector_synced_at;
