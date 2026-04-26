INSERT INTO settings (key, value, description, value_type)
VALUES
  ('export.pngRenderScale', '2', 'Render scale for PNG diagram images in exports (1-4, higher = sharper but larger files)', 'integer')
ON CONFLICT (key) DO NOTHING;

INSERT INTO metadata (entity_type, field, description, value_type, default_value)
VALUES
  ('memory', 'export-png-render-scale', 'Override render scale for PNG diagram images when exporting (1-4)', 'integer', NULL)
ON CONFLICT (entity_type, field) DO NOTHING;

-- DOWN
DELETE FROM metadata WHERE entity_type = 'memory' AND field = 'export-png-render-scale';
DELETE FROM settings WHERE key = 'export.pngRenderScale';
