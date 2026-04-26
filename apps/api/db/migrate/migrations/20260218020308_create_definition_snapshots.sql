-- Migration: Create kdag.definition_snapshots table for versioned definition history
-- Created: 2026-02-18T02:03:08Z

-- UP
CREATE TABLE kdag.definition_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  definition_id UUID NOT NULL REFERENCES kdag.job_definitions(id) ON DELETE CASCADE,
  snapshot_number INTEGER NOT NULL,
  name VARCHAR(200),
  description TEXT,
  steps_json JSONB NOT NULL,
  inputs_json JSONB NOT NULL DEFAULT '[]',
  source VARCHAR(50) NOT NULL DEFAULT 'pre-update',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (definition_id, snapshot_number)
);

CREATE INDEX idx_definition_snapshots_definition_id ON kdag.definition_snapshots(definition_id);

-- DOWN
DROP TABLE IF EXISTS kdag.definition_snapshots;
