-- Migration: Reconcile stale codex-cli config paths with current seed migration
-- Created: 2026-05-07T20:35:30.629Z
--
-- Some databases that ran 20260124021218_add_assistant_config_paths.sql before
-- the file was edited still carry stale codex-cli rows: '~/.codex/instructions.md'
-- (now '~/.codex/AGENTS.md') and a missing global config.toml entry. The
-- migration runner tracks applied state by filename, not contents, so later
-- edits to that migration never replay. Mirror the
-- 20260430161204_fix_stale_dev_mem_path_templates.sql precedent and reconcile
-- the stale rows in place so codex-cli passes the isAssistantInstalled gate
-- once a real ~/.codex/AGENTS.md or ~/.codex/config.toml is present on disk.
-- Idempotent for machines that already have the modern values.

-- UP

UPDATE assistant_config_paths
SET path_template = '~/.codex/AGENTS.md',
    format = 'markdown',
    description = 'Global Codex agent instructions'
WHERE assistant_id = (SELECT id FROM assistants WHERE handle = 'codex-cli')
  AND scope = 'global'
  AND type = 'instructions'
  AND path_template = '~/.codex/instructions.md';

INSERT INTO assistant_config_paths (assistant_id, scope, type, path_template, format, description)
SELECT a.id, 'global', 'settings', '~/.codex/config.toml', 'toml', 'Global Codex CLI settings'
FROM assistants a
WHERE a.handle = 'codex-cli'
ON CONFLICT (assistant_id, scope, type) DO NOTHING;

-- DOWN

-- No-op. Reverting would reintroduce stale references with no record of which
-- rows pre-existed.
SELECT 1;
