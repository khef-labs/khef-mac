-- Migration: Create active_sessions table
-- Caches OS-level session liveness detection results
-- Source of truth is lsof scanning; this table provides fast reads and history

-- UP

CREATE TABLE active_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(100) NOT NULL,
  assistant_id UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  file_path TEXT NOT NULL,
  project_dir VARCHAR(500),
  pid INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (session_id)
);

CREATE INDEX active_sessions_status_idx ON active_sessions(status);
CREATE INDEX active_sessions_assistant_idx ON active_sessions(assistant_id);

-- DOWN

DROP TABLE IF EXISTS active_sessions;
