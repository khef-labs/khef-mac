-- Migration: Add Kdag Definitions Hidden Setting
-- Created: 2026-04-25

-- UP

INSERT INTO settings (key, value, description, value_type)
VALUES ('kdag.definitions.hidden', '', 'Comma-separated definition keys to hide from the Definitions page', 'string')
ON CONFLICT (key) DO NOTHING;

-- DOWN

DELETE FROM settings WHERE key = 'kdag.definitions.hidden';
