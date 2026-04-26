-- Migration: Add vector batch size setting
-- Created: 2026-01-28T23:38:16Z

-- UP
INSERT INTO settings (key, value, description, value_type) VALUES
  ('vector.batchSize', '50', 'Number of memories to process per sync cycle', 'integer');

-- DOWN
DELETE FROM settings WHERE key = 'vector.batchSize';
