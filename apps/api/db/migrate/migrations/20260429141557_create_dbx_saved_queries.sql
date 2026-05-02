-- Migration: Create dbx saved queries tables
-- Created: 2026-04-29T19:15:57Z

-- UP

-- Saved queries: parameterized SQL bound to an optional connection.
CREATE TABLE dbx.saved_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID REFERENCES dbx.connections(id) ON DELETE SET NULL,
  name VARCHAR(200) NOT NULL,
  handle VARCHAR(100) NOT NULL,
  description TEXT,
  sql TEXT NOT NULL DEFAULT '',
  schema_scope VARCHAR(50),
  is_shared BOOLEAN NOT NULL DEFAULT false,
  is_readonly BOOLEAN NOT NULL DEFAULT true,
  owner_session_id VARCHAR(100),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dbx_saved_queries_handle_format CHECK (handle ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

-- Handle is unique per connection (and within the NULL bucket). Postgres treats
-- NULL as distinct in UNIQUE by default, so use COALESCE to bucket NULLs together.
CREATE UNIQUE INDEX idx_dbx_saved_queries_handle_per_conn
  ON dbx.saved_queries (COALESCE(connection_id::text, ''), handle);

CREATE INDEX idx_dbx_saved_queries_updated
  ON dbx.saved_queries (connection_id, updated_at DESC);

CREATE TRIGGER update_dbx_saved_queries_updated_at
  BEFORE UPDATE ON dbx.saved_queries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Declared parameters for a saved query.
CREATE TABLE dbx.saved_query_params (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id UUID NOT NULL REFERENCES dbx.saved_queries(id) ON DELETE CASCADE,
  name VARCHAR(64) NOT NULL,
  value_type VARCHAR(16) NOT NULL DEFAULT 'text',
  required BOOLEAN NOT NULL DEFAULT false,
  default_value TEXT,
  options JSONB,
  sort_order INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT dbx_saved_query_params_name_format CHECK (name ~ '^[a-zA-Z_][a-zA-Z0-9_]*$'),
  CONSTRAINT dbx_saved_query_params_value_type CHECK (value_type IN ('text','number','bool','enum')),
  UNIQUE (query_id, name)
);

CREATE INDEX idx_dbx_saved_query_params_query
  ON dbx.saved_query_params (query_id, sort_order);

-- Per-session favorites.
CREATE TABLE dbx.saved_query_favorites (
  query_id UUID NOT NULL REFERENCES dbx.saved_queries(id) ON DELETE CASCADE,
  session_id VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (query_id, session_id)
);

CREATE INDEX idx_dbx_saved_query_favorites_session
  ON dbx.saved_query_favorites (session_id, created_at DESC);

-- Version history snapshots. Captured on every edit that mutates SQL or params.
CREATE TABLE dbx.saved_query_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id UUID NOT NULL REFERENCES dbx.saved_queries(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  sql TEXT NOT NULL,
  params_snapshot JSONB,
  edited_by VARCHAR(100),
  edited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (query_id, version)
);

CREATE INDEX idx_dbx_saved_query_versions_query
  ON dbx.saved_query_versions (query_id, version DESC);

-- Extend query_history so saved-query runs and ad-hoc runs share one log.
ALTER TABLE dbx.query_history
  ADD COLUMN query_id UUID REFERENCES dbx.saved_queries(id) ON DELETE SET NULL,
  ADD COLUMN session_id VARCHAR(100),
  ADD COLUMN params_snapshot JSONB,
  ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'success';

ALTER TABLE dbx.query_history
  ADD CONSTRAINT dbx_query_history_status CHECK (status IN ('success','error','canceled'));

CREATE INDEX idx_dbx_query_history_query
  ON dbx.query_history (query_id, created_at DESC)
  WHERE query_id IS NOT NULL;

CREATE INDEX idx_dbx_query_history_session
  ON dbx.query_history (session_id, created_at DESC)
  WHERE session_id IS NOT NULL;

-- DOWN

DROP INDEX IF EXISTS dbx.idx_dbx_query_history_session;
DROP INDEX IF EXISTS dbx.idx_dbx_query_history_query;
ALTER TABLE dbx.query_history DROP CONSTRAINT IF EXISTS dbx_query_history_status;
ALTER TABLE dbx.query_history
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS params_snapshot,
  DROP COLUMN IF EXISTS session_id,
  DROP COLUMN IF EXISTS query_id;

DROP TABLE IF EXISTS dbx.saved_query_versions;
DROP TABLE IF EXISTS dbx.saved_query_favorites;
DROP TABLE IF EXISTS dbx.saved_query_params;
DROP TABLE IF EXISTS dbx.saved_queries;
