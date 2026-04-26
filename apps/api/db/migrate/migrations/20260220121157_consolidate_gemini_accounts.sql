-- Migration: Consolidate Gemini Accounts
-- Created: 2026-02-20T18:11:57.106Z
-- Merges gemini.account and gemini.healthAccounts into gemini.accounts

-- UP

-- Rename gemini.healthAccounts to gemini.accounts, preserving existing value
UPDATE settings
SET key = 'gemini.accounts',
    description = 'JSON array of gcloud account identifiers for Gemini authentication and health checks'
WHERE key = 'gemini.healthAccounts';

-- If gemini.healthAccounts didn't exist, create gemini.accounts
INSERT INTO settings (key, value, description, value_type)
VALUES (
  'gemini.accounts',
  '[]',
  'JSON array of gcloud account identifiers for Gemini authentication and health checks',
  'json'
)
ON CONFLICT (key) DO NOTHING;

-- Remove the old gemini.account setting
DELETE FROM settings WHERE key = 'gemini.account';


-- DOWN

-- Restore gemini.healthAccounts from gemini.accounts
UPDATE settings
SET key = 'gemini.healthAccounts',
    description = 'Optional JSON array of gcloud account identifiers to use for Gemini health checks; when empty, only active account is checked'
WHERE key = 'gemini.accounts';

-- Restore gemini.account
INSERT INTO settings (key, value, description, value_type)
VALUES (
  'gemini.account',
  '',
  'Optional gcloud account for Vertex AI token generation (e.g., workforce principal)',
  'string'
)
ON CONFLICT (key) DO NOTHING;
