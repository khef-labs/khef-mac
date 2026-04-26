-- Migration: Create assistant configuration tables
-- Normalized schema: configs hold content, join tables link to assistants/projects

-- Assistant registry (extensible)
CREATE TABLE assistants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Config instances (main table with content and sync state)
CREATE TABLE configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope VARCHAR(20) NOT NULL,              -- 'system', 'global', 'project', 'local'
  type VARCHAR(20) NOT NULL,               -- 'settings', 'instructions', 'rules', 'mcp'
  path TEXT NOT NULL,                      -- resolved filesystem path
  format VARCHAR(20) NOT NULL,             -- 'json', 'markdown', 'toml'
  content TEXT NOT NULL,
  file_hash TEXT,                          -- SHA256 for sync comparison
  version INT NOT NULL DEFAULT 1,          -- increments on each update
  auto_sync BOOLEAN DEFAULT false,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User-wide configs (system/global scope)
-- Links assistant to config
CREATE TABLE assistant_configs (
  assistant_id UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  config_id UUID NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
  PRIMARY KEY (assistant_id, config_id)
);

-- Project-scoped configs (project/local scope)
-- Links project + assistant to config
CREATE TABLE project_assistant_configs (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  assistant_id UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  config_id UUID NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, assistant_id, config_id)
);

-- Indexes
CREATE INDEX idx_configs_scope ON configs(scope);
CREATE INDEX idx_configs_type ON configs(type);
CREATE INDEX idx_configs_path ON configs(path);
CREATE INDEX idx_assistant_configs_assistant ON assistant_configs(assistant_id);
CREATE INDEX idx_assistant_configs_config ON assistant_configs(config_id);
CREATE INDEX idx_project_assistant_configs_project ON project_assistant_configs(project_id);
CREATE INDEX idx_project_assistant_configs_assistant ON project_assistant_configs(assistant_id);
CREATE INDEX idx_project_assistant_configs_config ON project_assistant_configs(config_id);

-- Seed: Assistants
INSERT INTO assistants (handle, name, description) VALUES
('claude-code', 'Claude Code', 'Anthropic Claude Code CLI assistant'),
('codex-cli', 'Codex CLI', 'OpenAI Codex CLI assistant');

-- DOWN

DROP TABLE IF EXISTS project_assistant_configs;
DROP TABLE IF EXISTS assistant_configs;
DROP TABLE IF EXISTS configs;
DROP TABLE IF EXISTS assistants;
