-- Migration: Merge active_sessions columns into sessions table
-- Created: 2026-04-09T19:19:41Z
--
-- Phase 1 of the session unification plan. Adds runtime columns from
-- active_sessions to sessions, migrates data, inserts orphan rows,
-- and drops active_sessions.

-- UP

-- 1. Add runtime columns from active_sessions
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'inactive';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pid INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS terminal_session_id VARCHAR(255);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project_dir VARCHAR(500);

-- 2. Relax file_size NOT NULL — heartbeat-only sessions won't have it
ALTER TABLE sessions ALTER COLUMN file_size DROP NOT NULL;
ALTER TABLE sessions ALTER COLUMN file_size SET DEFAULT 0;

-- 3. Relax file_path NOT NULL — heartbeat-only sessions may have empty paths initially
-- (keeping NOT NULL but adding a default so inserts without file_path work)
-- Actually file_path comes from heartbeat, so it's always present. Keep NOT NULL.

-- 4. Migrate data from active_sessions into matching sessions rows
UPDATE sessions s
SET
  status = a.status,
  pid = a.pid,
  terminal_session_id = a.terminal_session_id,
  last_seen_at = a.last_seen_at,
  first_seen_at = a.first_seen_at,
  project_dir = a.project_dir,
  nickname = COALESCE(s.nickname, a.nickname)
FROM active_sessions a
WHERE s.session_id = a.session_id;

-- 5. Insert active_sessions-only rows (heartbeated but never synced)
INSERT INTO sessions (session_id, assistant_id, project_id, file_path, file_size, nickname, status, pid, terminal_session_id, last_seen_at, first_seen_at, project_dir, created_at, updated_at)
SELECT
  a.session_id,
  a.assistant_id,
  a.project_id,
  a.file_path,
  0,  -- file_size unknown
  a.nickname,
  a.status,
  a.pid,
  a.terminal_session_id,
  a.last_seen_at,
  a.first_seen_at,
  a.project_dir,
  a.created_at,
  a.updated_at
FROM active_sessions a
LEFT JOIN sessions s ON a.session_id = s.session_id
WHERE s.id IS NULL;

-- 6. Add indexes matching what active_sessions had
CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions (status);
CREATE INDEX IF NOT EXISTS idx_sessions_nickname ON sessions (nickname) WHERE nickname IS NOT NULL;

-- 7. Drop active_sessions
DROP TABLE IF EXISTS active_sessions;


-- DOWN

-- Recreate active_sessions
CREATE TABLE active_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(100) NOT NULL UNIQUE,
  assistant_id UUID NOT NULL REFERENCES assistants(id),
  project_id UUID REFERENCES projects(id),
  file_path TEXT NOT NULL,
  project_dir VARCHAR(500),
  pid INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  nickname VARCHAR(50),
  terminal_session_id VARCHAR(255)
);

CREATE INDEX active_sessions_assistant_idx ON active_sessions (assistant_id);
CREATE INDEX active_sessions_status_idx ON active_sessions (status);
CREATE INDEX idx_active_sessions_nickname ON active_sessions (nickname) WHERE nickname IS NOT NULL;

-- Copy runtime data back from sessions into active_sessions
INSERT INTO active_sessions (session_id, assistant_id, project_id, file_path, project_dir, pid, status, last_seen_at, first_seen_at, created_at, updated_at, nickname, terminal_session_id)
SELECT session_id, assistant_id, project_id, file_path, project_dir, pid, COALESCE(status, 'inactive'), last_seen_at, first_seen_at, created_at, updated_at, nickname, terminal_session_id
FROM sessions
WHERE status IS NOT NULL OR pid IS NOT NULL OR last_seen_at IS NOT NULL;

-- Remove added columns from sessions
DROP INDEX IF EXISTS sessions_status_idx;
DROP INDEX IF EXISTS idx_sessions_nickname;
ALTER TABLE sessions DROP COLUMN IF EXISTS status;
ALTER TABLE sessions DROP COLUMN IF EXISTS pid;
ALTER TABLE sessions DROP COLUMN IF EXISTS terminal_session_id;
ALTER TABLE sessions DROP COLUMN IF EXISTS last_seen_at;
ALTER TABLE sessions DROP COLUMN IF EXISTS first_seen_at;
ALTER TABLE sessions DROP COLUMN IF EXISTS project_dir;

-- Restore file_size NOT NULL
ALTER TABLE sessions ALTER COLUMN file_size SET NOT NULL;
ALTER TABLE sessions ALTER COLUMN file_size DROP DEFAULT;
