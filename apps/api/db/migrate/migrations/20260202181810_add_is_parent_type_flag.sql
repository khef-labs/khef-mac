-- Migration: Add is_parent_type flag to memory_types
-- Indicates whether a type can have child types

-- UP
ALTER TABLE memory_types ADD COLUMN is_parent_type BOOLEAN NOT NULL DEFAULT FALSE;

-- Set existing parent types
UPDATE memory_types SET is_parent_type = TRUE WHERE name IN ('knowledge', 'google-doc');

-- DOWN
ALTER TABLE memory_types DROP COLUMN is_parent_type;
