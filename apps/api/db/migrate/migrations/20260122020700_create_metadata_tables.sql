-- Migration: Create metadata system tables
-- This migration:
-- 1. Creates metadata table for defining available fields per entity type
-- 2. Creates memory_metadata table for storing values per memory
-- 3. Seeds initial svg-max-width field for diagram memories

-- Step 1: Create metadata table (field definitions)
CREATE TABLE IF NOT EXISTS metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type VARCHAR(50) NOT NULL,
  field VARCHAR(100) NOT NULL,
  description TEXT,
  value_type VARCHAR(20) DEFAULT 'string',
  default_value TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(entity_type, field)
);

-- Step 2: Create memory_metadata table (values per memory)
CREATE TABLE IF NOT EXISTS memory_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  metadata_id UUID NOT NULL REFERENCES metadata(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(memory_id, metadata_id)
);

-- Step 3: Create indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_memory_metadata_memory_id ON memory_metadata(memory_id);
CREATE INDEX IF NOT EXISTS idx_metadata_entity_type ON metadata(entity_type);

-- Step 4: Seed initial metadata fields
INSERT INTO metadata (entity_type, field, description, value_type, default_value)
VALUES
  ('memory', 'svg-max-width', 'Maximum width in pixels for SVG diagram rendering', 'integer', '800')
ON CONFLICT (entity_type, field) DO NOTHING;

-- DOWN

-- Remove indexes
DROP INDEX IF EXISTS idx_memory_metadata_memory_id;
DROP INDEX IF EXISTS idx_metadata_entity_type;

-- Drop tables (memory_metadata first due to FK)
DROP TABLE IF EXISTS memory_metadata;
DROP TABLE IF EXISTS metadata;
