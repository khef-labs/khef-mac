-- DB-backed agents for assistants without native agent support (e.g., Codex CLI)

CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,  -- sonnet, opus, haiku, inherit
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE assistant_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_id UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'user',
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(assistant_id, agent_id, project_id)
);

-- Indexes for common queries
CREATE INDEX idx_assistant_agents_assistant ON assistant_agents(assistant_id);
CREATE INDEX idx_assistant_agents_agent ON assistant_agents(agent_id);
CREATE INDEX idx_assistant_agents_scope ON assistant_agents(scope);

-- DOWN

DROP INDEX IF EXISTS idx_assistant_agents_scope;
DROP INDEX IF EXISTS idx_assistant_agents_agent;
DROP INDEX IF EXISTS idx_assistant_agents_assistant;
DROP TABLE IF EXISTS assistant_agents;
DROP TABLE IF EXISTS agents;
