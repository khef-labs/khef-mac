-- Migration: Add editor scratch drawer settings

-- UP
INSERT INTO settings (key, value, description, value_type) VALUES
  ('editor.scratchHome', '', 'Absolute path to the scratch file home directory. Defaults to <repo-root>/khef-scratches when empty.', 'string'),
  ('editor.scratchDrawer.enabled', 'false', 'Show the Scratches tab and chicken toggle in the Editor sidebar.', 'boolean')
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key IN ('editor.scratchHome', 'editor.scratchDrawer.enabled');
