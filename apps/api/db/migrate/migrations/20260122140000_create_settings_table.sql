-- Migration: Create settings table for app configuration
-- This migration:
-- 1. Creates settings table with key-value storage
-- 2. Seeds initial layout and diagram settings

-- Step 1: Create settings table
CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  value_type VARCHAR(20) DEFAULT 'string',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 2: Create index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_settings_key ON settings(key);

-- Step 3: Seed initial settings
INSERT INTO settings (key, value, description, value_type) VALUES
  ('layout.pageWidth', '900', 'Max width for main content area (pixels)', 'integer'),
  ('diagram.defaultMaxWidth', '800', 'Default max width for SVG diagrams (pixels)', 'integer')
ON CONFLICT (key) DO NOTHING;

-- DOWN

-- Remove index
DROP INDEX IF EXISTS idx_settings_key;

-- Drop table
DROP TABLE IF EXISTS settings;
