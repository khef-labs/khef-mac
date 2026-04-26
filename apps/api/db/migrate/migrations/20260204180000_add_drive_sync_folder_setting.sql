-- Migration: Add drive sync folder setting for save-to-drive feature

-- UP
INSERT INTO settings (key, value, description, value_type) VALUES
  ('drive.syncFolder', '', 'Absolute path to local Google Drive sync folder for save-to-drive', 'string')
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key = 'drive.syncFolder';
