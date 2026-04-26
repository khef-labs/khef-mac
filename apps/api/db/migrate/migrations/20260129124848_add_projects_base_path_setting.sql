-- Migration: Add Projects Base Path Setting
-- Created: 2026-01-29T18:48:48.746Z

-- UP

INSERT INTO settings (key, value, description, value_type)
VALUES (
  'projects.basePath',
  '',
  'Base directory for projects. When set, project paths are derived as {basePath}/{handle} if directory exists.',
  'string'
);

-- DOWN

DELETE FROM settings WHERE key = 'projects.basePath';


