-- Migration: Add export image theme and scale settings with metadata fields
-- Adds global default settings and per-memory override metadata for both.

-- UP
INSERT INTO settings (key, value, description, value_type) VALUES
  ('export.imageTheme', 'dark', 'Default theme for diagram images in exports (dark|light|neutral|forest|ocean)', 'string'),
  ('export.diagramScale', '2', 'Default scale factor for diagram images in exports (1-4, higher = sharper but larger files)', 'integer')
ON CONFLICT (key) DO NOTHING;

INSERT INTO metadata (entity_type, field, description, value_type, default_value) VALUES
  ('memory', 'export-image-theme', 'Override theme for diagram images when exporting (dark|light|neutral|forest|ocean)', 'string', NULL),
  ('memory', 'export-diagram-scale', 'Override scale factor for diagram images when exporting (1-4)', 'integer', NULL)
ON CONFLICT (entity_type, field) DO NOTHING;

-- DOWN
DELETE FROM metadata WHERE entity_type = 'memory' AND field IN ('export-image-theme', 'export-diagram-scale');
DELETE FROM settings WHERE key IN ('export.imageTheme', 'export.diagramScale');
