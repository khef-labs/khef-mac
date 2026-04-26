-- Migration: Add backup.location setting
-- Created: 2026-02-15

-- UP
INSERT INTO settings (key, value, description, value_type)
VALUES (
  'backup.location',
  'db/backups',
  'Directory path for database backups (relative to apps/api/ or absolute)',
  'string'
)
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key = 'backup.location';
