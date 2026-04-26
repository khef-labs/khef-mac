-- Migration: Add optional Gemini health check account allowlist
-- Created: 2026-02-20T10:00:00Z

-- UP
INSERT INTO settings (key, value, description, value_type)
VALUES (
  'gemini.healthAccounts',
  '[]',
  'Optional JSON array of gcloud account identifiers to use for Gemini health checks; when empty, only active account is checked',
  'json'
)
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key = 'gemini.healthAccounts';
