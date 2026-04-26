-- Migration: Add export.highQualityRendering setting and update imageTheme default to light
-- Created: 2026-03-11T11:09:21Z

-- UP
INSERT INTO settings (key, value, description, value_type) VALUES
  ('export.highQualityRendering', 'true', 'Use browser-based rendering for sharper diagram images in DOCX exports', 'boolean')
ON CONFLICT (key) DO NOTHING;

UPDATE settings SET value = 'light' WHERE key = 'export.imageTheme' AND value = 'dark';

-- DOWN
DELETE FROM settings WHERE key = 'export.highQualityRendering';
