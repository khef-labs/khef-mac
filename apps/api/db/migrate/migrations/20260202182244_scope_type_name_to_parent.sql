-- Migration: Scope type name uniqueness to parent
-- Allows same name under different parents (e.g., design-doc standalone AND design-doc under google-doc)

-- UP

-- Drop existing unique constraint on name
ALTER TABLE memory_types DROP CONSTRAINT IF EXISTS memory_types_name_key;

-- Create unique index on (name, parent_id) using COALESCE for NULL parent_id
-- This ensures uniqueness within each parent scope (including no-parent scope)
CREATE UNIQUE INDEX memory_types_name_parent_unique
ON memory_types (name, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- DOWN
DROP INDEX IF EXISTS memory_types_name_parent_unique;
ALTER TABLE memory_types ADD CONSTRAINT memory_types_name_key UNIQUE (name);
