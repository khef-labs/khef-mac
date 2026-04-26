-- Migration: Add kdag.allowedTools setting for configurable tool access in pipeline steps
-- Created: 2026-03-06T23:59:30.463Z

-- UP
INSERT INTO settings (key, value, description, value_type)
VALUES ('kdag.allowedTools',
  '["mcp__khef__*","Read","Write","Edit","Bash","Glob","Grep","WebFetch","WebSearch"]',
  'Tools Claude is allowed to use when executing kdag pipeline steps (JSON array)',
  'json')
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key = 'kdag.allowedTools';
