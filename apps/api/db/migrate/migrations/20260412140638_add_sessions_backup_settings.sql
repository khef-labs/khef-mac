-- Migration: Add sessions backup settings (persistent copy of JSONL files)
-- Created: 2026-04-12T14:06:38.000Z

-- UP
INSERT INTO settings (key, value, description, value_type) VALUES
  ('sessions.backupPath', '', 'Absolute path for persistent session JSONL copies. Empty disables backup.', 'string'),
  ('sessions.backupEnabled', 'false', 'Enable persistent copy of session JSONL files during sync', 'boolean')
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key IN ('sessions.backupPath', 'sessions.backupEnabled');
