-- Migration: Add Gemini Models Setting
-- Configurable list of available Gemini models

-- UP
INSERT INTO settings (key, value, description, value_type) VALUES
  ('gemini.models', '[{"id":"gemini-2.0-flash-001","label":"Gemini 2.0 Flash"},{"id":"gemini-1.5-pro-002","label":"Gemini 1.5 Pro"},{"id":"gemini-1.5-flash-002","label":"Gemini 1.5 Flash"}]', 'Available Gemini models (JSON array with id and label)', 'json')
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key = 'gemini.models';
