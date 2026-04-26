-- Migration: Add optional Gemini account setting for explicit Vertex auth principal
-- Created: 2026-02-18T10:30:00Z

-- UP
INSERT INTO settings (key, value, description, value_type)
VALUES (
  'gemini.account',
  '',
  'Optional gcloud account for Vertex AI token generation (e.g., workforce principal)',
  'string'
)
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key = 'gemini.account';
