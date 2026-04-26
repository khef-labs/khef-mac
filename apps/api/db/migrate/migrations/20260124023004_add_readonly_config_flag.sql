-- Migration: Add readonly flag to configs
-- Some config files should be viewable but not editable (e.g., internal state files)

-- Add readonly flag to path templates
ALTER TABLE assistant_config_paths ADD COLUMN readonly BOOLEAN DEFAULT false;

-- Add readonly flag to configs
ALTER TABLE configs ADD COLUMN readonly BOOLEAN DEFAULT false;

-- Add the ~/.claude.json file as readonly (internal state, not user-editable)
-- Using 'state' type to differentiate from regular settings
INSERT INTO assistant_config_paths (assistant_id, scope, type, path_template, format, description, readonly)
SELECT a.id, 'global', 'state', '~/.claude.json', 'json', 'Claude Code internal state (read-only)', true
FROM assistants a
WHERE a.handle = 'claude-code';

-- DOWN

DELETE FROM assistant_config_paths WHERE path_template = '~/.claude.json';
ALTER TABLE configs DROP COLUMN readonly;
ALTER TABLE assistant_config_paths DROP COLUMN readonly;
