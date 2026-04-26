-- Migration: Add Knowledge Config Paths
-- Created: 2026-01-29T17:17:51.861Z

-- UP

-- Add knowledge config paths for project-level KF-PROJECT-KNOWLEDGE.md
INSERT INTO assistant_config_paths (assistant_id, scope, type, path_template, format, readonly)
SELECT id, 'local', 'knowledge', '{project}/KF-PROJECT-KNOWLEDGE.md', 'markdown', true
FROM assistants WHERE handle = 'claude-code';

INSERT INTO assistant_config_paths (assistant_id, scope, type, path_template, format, readonly)
SELECT id, 'local', 'knowledge', '{project}/KF-PROJECT-KNOWLEDGE.md', 'markdown', true
FROM assistants WHERE handle = 'codex-cli';

-- DOWN

DELETE FROM assistant_config_paths WHERE type = 'knowledge' AND path_template = '{project}/KF-PROJECT-KNOWLEDGE.md';
