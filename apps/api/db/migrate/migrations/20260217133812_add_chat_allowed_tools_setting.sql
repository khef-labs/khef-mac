-- Migration: Add Chat Allowed Tools Setting
-- Created: 2026-02-17T19:38:12.881Z

-- UP
INSERT INTO settings (key, value, description, value_type) VALUES
  ('chat.claudeAllowedTools',
   '["mcp__khef__*","WebSearch","WebFetch","Read","Glob","Grep","Edit","Write","Bash"]',
   'JSON array of tool names Claude is allowed to use in browser chat sessions',
   'json')
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key = 'chat.claudeAllowedTools';
