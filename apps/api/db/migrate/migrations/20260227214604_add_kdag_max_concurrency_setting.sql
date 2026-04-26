-- Migration: Add kdag.maxConcurrency setting for concurrent job execution
-- Created: 2026-02-27T21:46:04Z

-- UP
INSERT INTO settings (key, value, description, value_type)
VALUES ('kdag.maxConcurrency', '3', 'Maximum number of kdag jobs that can run simultaneously', 'number')
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key = 'kdag.maxConcurrency';
