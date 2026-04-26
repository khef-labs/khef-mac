-- Migration: Create sessions and session_chunks tables
-- Stores parsed session transcripts for full-text search
-- Supports both Claude Code and Codex CLI sessions

-- UP

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(100) NOT NULL,
  assistant_id UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  name VARCHAR(255),
  summary TEXT,
  message_count INTEGER,
  file_size BIGINT NOT NULL,
  file_path TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (assistant_id, session_id)
);

CREATE TABLE session_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  message_count INTEGER,

  UNIQUE (session_id, chunk_index)
);

-- Indexes
CREATE INDEX sessions_project_idx ON sessions(project_id);
CREATE INDEX sessions_assistant_idx ON sessions(assistant_id);
CREATE INDEX sessions_started_at_idx ON sessions(started_at DESC);

-- Full-text search on chunks
CREATE INDEX session_chunks_fts_idx ON session_chunks
  USING gin(to_tsvector('english', content));

-- Full-text search on summary
CREATE INDEX sessions_summary_fts_idx ON sessions
  USING gin(to_tsvector('english', coalesce(summary, '')));

-- DOWN

DROP TABLE IF EXISTS session_chunks;
DROP TABLE IF EXISTS sessions;
