-- Migration: Add assistant config paths table for auto-discovery
-- Stores known config file paths/templates for each assistant

CREATE TABLE assistant_config_paths (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_id UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  scope VARCHAR(20) NOT NULL,       -- 'system', 'global', 'project', 'local'
  type VARCHAR(20) NOT NULL,        -- 'settings', 'instructions', 'rules', 'mcp'
  path_template TEXT NOT NULL,      -- e.g., "~/.claude/settings.json" or "{project}/.claude/CLAUDE.md"
  format VARCHAR(20) NOT NULL,      -- 'json', 'markdown', 'toml'
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(assistant_id, scope, type)
);

CREATE INDEX idx_assistant_config_paths_assistant ON assistant_config_paths(assistant_id);

-- Seed: Claude Code config paths
INSERT INTO assistant_config_paths (assistant_id, scope, type, path_template, format, description)
SELECT a.id, paths.scope, paths.type, paths.path_template, paths.format, paths.description
FROM assistants a
CROSS JOIN (VALUES
  ('global', 'settings', '~/.claude/settings.json', 'json', 'Global Claude Code settings'),
  ('global', 'instructions', '~/.claude/CLAUDE.md', 'markdown', 'Global instructions (user-wide)'),
  ('project', 'settings', '{project}/.claude/settings.json', 'json', 'Project-specific settings'),
  ('project', 'instructions', '{project}/CLAUDE.md', 'markdown', 'Project instructions'),
  ('local', 'settings', '{project}/.claude/settings.local.json', 'json', 'Local settings (not committed)'),
  ('local', 'instructions', '{project}/CLAUDE.local.md', 'markdown', 'Local instructions (not committed)')
) AS paths(scope, type, path_template, format, description)
WHERE a.handle = 'claude-code';

-- Seed: Codex CLI config paths
INSERT INTO assistant_config_paths (assistant_id, scope, type, path_template, format, description)
SELECT a.id, paths.scope, paths.type, paths.path_template, paths.format, paths.description
FROM assistants a
CROSS JOIN (VALUES
  ('global', 'settings', '~/.codex/config.toml', 'toml', 'Global Codex CLI settings'),
  ('global', 'instructions', '~/.codex/AGENTS.md', 'markdown', 'Global Codex agent instructions'),
  ('project', 'instructions', '{project}/AGENTS.md', 'markdown', 'Project agent instructions'),
  ('project', 'settings', '{project}/.codex/config.json', 'json', 'Project Codex settings')
) AS paths(scope, type, path_template, format, description)
WHERE a.handle = 'codex-cli';

-- DOWN

DROP TABLE IF EXISTS assistant_config_paths;
