-- Migration: Add Nickname Settings
-- Created: 2026-03-22T18:19:56.803Z

-- UP
INSERT INTO settings (key, value, description, value_type) VALUES
  ('nicknames.preferred', '[]', 'JSON array of preferred session nickname strings (tried before auto-generated names)', 'json'),
  ('nicknames.staleDays', '7', 'Days after last heartbeat before a session nickname is considered free for reuse', 'integer')
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key IN ('nicknames.preferred', 'nicknames.staleDays');
