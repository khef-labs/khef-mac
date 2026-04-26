INSERT INTO settings (key, value, description, value_type)
VALUES
  ('export.pngDisplayScalePercent', '100', 'Display scale percent for PNG diagram images in exports (10-300)', 'integer')
ON CONFLICT (key) DO NOTHING;

INSERT INTO metadata (entity_type, field, description, value_type, default_value)
VALUES
  ('memory', 'export-png-display-scale-percent', 'Override display scale percent for PNG diagram images when exporting (10-300)', 'integer', NULL)
ON CONFLICT (entity_type, field) DO NOTHING;

-- DOWN
DELETE FROM metadata WHERE entity_type = 'memory' AND field = 'export-png-display-scale-percent';
DELETE FROM settings WHERE key = 'export.pngDisplayScalePercent';
