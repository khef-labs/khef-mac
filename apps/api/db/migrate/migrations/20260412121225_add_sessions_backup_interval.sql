-- Migration: Add configurable session backup interval
-- Created: 2026-04-12T17:12:25.000Z

-- UP
INSERT INTO settings (key, value, description, value_type) VALUES
  ('sessions.backupIntervalMinutes', '10', 'How often the session backup worker scans for new or changed session files (minutes)', 'int')
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key = 'sessions.backupIntervalMinutes';
