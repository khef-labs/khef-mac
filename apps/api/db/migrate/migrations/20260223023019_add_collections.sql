-- Migration: Add collections and collection_memories tables for grouping related memories
-- Created: 2026-02-23

-- UP

CREATE TABLE collections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  handle VARCHAR(200) NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_collections_project_handle UNIQUE (project_id, handle)
);

CREATE INDEX idx_collections_project ON collections(project_id);

CREATE TABLE collection_memories (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection_id, memory_id)
);

CREATE INDEX idx_collection_memories_memory ON collection_memories(memory_id);

-- Add updated_at trigger for collections
CREATE TRIGGER update_collections_updated_at
  BEFORE UPDATE ON collections
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- DOWN

DROP TRIGGER IF EXISTS update_collections_updated_at ON collections;
DROP TABLE IF EXISTS collection_memories;
DROP TABLE IF EXISTS collections;
