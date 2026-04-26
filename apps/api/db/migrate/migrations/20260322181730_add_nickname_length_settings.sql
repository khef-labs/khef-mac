-- Migration: Add Nickname Length Settings
-- Created: 2026-03-22T23:17:30.073Z

-- UP
INSERT INTO settings (key, value, description, value_type) VALUES
  ('nicknames.minLength', '0', 'Minimum character length for auto-generated nicknames (0 = no minimum)', 'integer'),
  ('nicknames.maxLength', '0', 'Maximum character length for auto-generated nicknames (0 = no limit)', 'integer')
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key IN ('nicknames.minLength', 'nicknames.maxLength');
