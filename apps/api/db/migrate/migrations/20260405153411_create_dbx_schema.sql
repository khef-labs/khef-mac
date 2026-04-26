-- Migration: Create dbx schema for database explorer
-- Created: 2026-04-05T15:34:11Z

-- UP

CREATE SCHEMA IF NOT EXISTS dbx;

-- Connections to external (or builtin) databases
CREATE TABLE dbx.connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL UNIQUE,
  driver VARCHAR(50) NOT NULL DEFAULT 'postgres',
  config JSONB NOT NULL DEFAULT '{}',
  credentials JSONB DEFAULT NULL,
  is_builtin BOOLEAN NOT NULL DEFAULT false,
  options JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Saved SQL scripts
CREATE TABLE dbx.scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID REFERENCES dbx.connections(id) ON DELETE SET NULL,
  name VARCHAR(200) NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Query execution history
CREATE TABLE dbx.query_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES dbx.connections(id) ON DELETE CASCADE,
  sql TEXT NOT NULL,
  row_count INTEGER,
  duration_ms INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dbx_query_history_connection ON dbx.query_history(connection_id, created_at DESC);
CREATE INDEX idx_dbx_scripts_connection ON dbx.scripts(connection_id);

-- Auto-update updated_at
CREATE TRIGGER update_dbx_connections_updated_at
  BEFORE UPDATE ON dbx.connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_dbx_scripts_updated_at
  BEFORE UPDATE ON dbx.scripts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed builtin khef connection (port/db populated by startup sync from DATABASE_URL)
INSERT INTO dbx.connections (name, driver, config, is_builtin, options)
VALUES (
  'khef',
  'postgres',
  jsonb_build_object(
    'host', 'localhost',
    'port', 5432,
    'database', 'khef'
  ),
  true,
  jsonb_build_object('statement_timeout_ms', 30000)
);

-- DOWN

DROP SCHEMA IF EXISTS dbx CASCADE;
