-- Migration: Add Glossary Config Paths
-- Created: 2026-02-22T15:00:00.000Z

-- UP

-- Add glossary config paths for user-level KF-GLOSSARY.md
INSERT INTO assistant_config_paths (assistant_id, scope, type, path_template, format, readonly)
SELECT id, 'global', 'glossary', '~/.claude/KF-GLOSSARY.md', 'markdown', false
FROM assistants WHERE handle = 'claude-code';

-- Add glossary config paths for project-level KF-GLOSSARY.md
INSERT INTO assistant_config_paths (assistant_id, scope, type, path_template, format, readonly)
SELECT id, 'local', 'glossary', '{project}/KF-GLOSSARY.md', 'markdown', false
FROM assistants WHERE handle = 'claude-code';

-- DOWN

DELETE FROM assistant_config_paths WHERE type = 'glossary' AND path_template IN ('~/.claude/KF-GLOSSARY.md', '{project}/KF-GLOSSARY.md');
