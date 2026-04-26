-- Migration: Create Session Embeddings
-- Created: 2026-01-30
--
-- Track session files that have been embedded for vector search.
-- Uses file size for change detection (sessions are append-only).

-- UP

CREATE TABLE session_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_handle VARCHAR(50) NOT NULL,
  project_dir VARCHAR(500) NOT NULL,
  session_id VARCHAR(100) NOT NULL,
  file_size BIGINT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  embedded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (assistant_handle, project_dir, session_id)
);

-- Index for lookup by assistant and project
CREATE INDEX session_embeddings_assistant_project_idx
  ON session_embeddings (assistant_handle, project_dir);

-- DOWN

DROP TABLE IF EXISTS session_embeddings;
