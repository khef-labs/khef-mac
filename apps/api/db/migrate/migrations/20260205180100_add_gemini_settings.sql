-- Migration: Add Gemini Settings
-- GCP project, location, and default model for Vertex AI Gemini API

-- UP
INSERT INTO settings (key, value, description, value_type) VALUES
  ('gemini.project', '', 'GCP project ID for Vertex AI', 'string'),
  ('gemini.location', 'us-central1', 'GCP region for Vertex AI (e.g., us-central1)', 'string'),
  ('gemini.defaultModel', 'gemini-2.0-flash-001', 'Default Gemini model ID', 'string')
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key IN ('gemini.project', 'gemini.location', 'gemini.defaultModel');
