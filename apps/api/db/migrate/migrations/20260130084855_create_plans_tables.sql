-- Migration: Create plans and plan_versions tables
-- Plans track Claude Code plan files with version history

-- Plans table: Current version pointer and metadata
CREATE TABLE plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_id UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  filename VARCHAR(255) NOT NULL,
  file_path TEXT,                  -- NULL = file deleted, DB only
  current_version INT DEFAULT 1,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(assistant_id, filename)
);

-- Plan versions table: Immutable content snapshots
CREATE TABLE plan_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  version INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  size INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(plan_id, version)
);

-- Indexes for efficient queries
CREATE INDEX idx_plans_assistant ON plans(assistant_id);
CREATE INDEX idx_plans_project ON plans(project_id);
CREATE INDEX idx_plans_status ON plans(status);
CREATE INDEX idx_plans_filename ON plans(filename);
CREATE INDEX idx_plan_versions_plan ON plan_versions(plan_id);
CREATE INDEX idx_plan_versions_hash ON plan_versions(file_hash);

-- DOWN

DROP TABLE IF EXISTS plan_versions;
DROP TABLE IF EXISTS plans;
