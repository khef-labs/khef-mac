-- Migration: Create kvec_auto_embed table
-- Stores per-repo per-branch auto-embed configurations for scheduled embedding

-- UP

CREATE TABLE kvec_auto_embed (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_path TEXT NOT NULL,
  branch VARCHAR(255) NOT NULL DEFAULT 'main',
  job_type VARCHAR(20) NOT NULL DEFAULT 'commits',
  enabled BOOLEAN NOT NULL DEFAULT true,
  batch_delay_ms INTEGER NOT NULL DEFAULT 1000,
  last_run_at TIMESTAMPTZ,
  last_commit_hash VARCHAR(40),
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (repo_path, branch, job_type),
  CHECK (job_type IN ('commits', 'source'))
);

CREATE INDEX kvec_auto_embed_enabled_idx ON kvec_auto_embed(enabled) WHERE enabled = true;

-- DOWN

DROP TABLE IF EXISTS kvec_auto_embed;
