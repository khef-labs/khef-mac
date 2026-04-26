-- Migration tracking table
-- This table records which migrations have been applied to the database

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(14) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for quick lookups of migration history
CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at
  ON schema_migrations(applied_at DESC);
