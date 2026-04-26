-- Migration: Add Projects Hidden Setting
-- Created: 2026-04-04T02:40:32.040Z

-- UP

INSERT INTO settings (key, value, description, value_type)
VALUES ('projects.hidden', '', 'Comma-separated project handles to hide from the Projects page and search results', 'string')
ON CONFLICT (key) DO NOTHING;

-- DOWN

DELETE FROM settings WHERE key = 'projects.hidden';
