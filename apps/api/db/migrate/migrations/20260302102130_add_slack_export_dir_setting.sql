-- Migration: Add slack.exportDir setting
-- Created: 2026-03-02

-- UP
INSERT INTO settings (key, value, description, value_type) VALUES
  ('slack.exportDir', 'chats', 'Default base directory for Slack channel exports (relative to project root)', 'string')
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key = 'slack.exportDir';
