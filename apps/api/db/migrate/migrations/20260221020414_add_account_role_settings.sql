-- Migration: Add account role settings for Vertex AI and Google Drive
-- Created: 2026-02-21T02:04:14Z

-- UP
INSERT INTO settings (key, value, description, value_type)
VALUES
  ('gemini.vertexAccount', '', 'Account for Vertex AI API calls', 'string'),
  ('gemini.driveAccount', '', 'Account for Google Drive API calls', 'string')
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key IN ('gemini.vertexAccount', 'gemini.driveAccount');
