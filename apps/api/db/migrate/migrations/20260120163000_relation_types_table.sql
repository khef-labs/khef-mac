-- Migration: Create relation_types table and convert from ENUM
-- This migration:
-- 1. Creates relation_types table with forward/inverse labels
-- 2. Seeds all relation types (existing + new)
-- 3. Converts memory_relations.relation_type from ENUM to VARCHAR
-- 4. Adds blocked and on_hold statuses to todo types

-- Step 1: Create relation_types table
CREATE TABLE IF NOT EXISTS relation_types (
  value VARCHAR(50) PRIMARY KEY,
  forward_label VARCHAR(100) NOT NULL,
  inverse_value VARCHAR(50) NOT NULL,
  inverse_label VARCHAR(100) NOT NULL
);

-- Step 2: Seed relation types
INSERT INTO relation_types (value, forward_label, inverse_value, inverse_label) VALUES
  ('relates_to', 'Relates To', 'relates_to', 'Relates To'),
  ('supports', 'Supports', 'is_supported_by', 'Supported By'),
  ('contradicts', 'Contradicts', 'is_contradicted_by', 'Contradicted By'),
  ('depends_on', 'Depends On', 'is_depended_on_by', 'Depended On By'),
  ('follows_from', 'Follows From', 'is_followed_by', 'Followed By'),
  ('references', 'References', 'is_referenced_by', 'Referenced By'),
  ('supersedes', 'Supersedes', 'is_superseded_by', 'Superseded By'),
  ('implements', 'Implements', 'is_implemented_by', 'Implemented By'),
  ('blocks', 'Blocks', 'is_blocked_by', 'Blocked By'),
  ('extends', 'Extends', 'is_extended_by', 'Extended By'),
  ('duplicates', 'Duplicates', 'is_duplicated_by', 'Duplicated By')
ON CONFLICT (value) DO NOTHING;

-- Step 3: Convert memory_relations.relation_type from ENUM to VARCHAR
-- First, drop the view that depends on relation_type
DROP VIEW IF EXISTS memory_relations_expanded;

-- Drop constraints and indexes that depend on relation_type
ALTER TABLE memory_relations DROP CONSTRAINT IF EXISTS memory_relations_source_memory_id_target_memory_id_relation_key;
DROP INDEX IF EXISTS idx_memory_relations_type;

-- Add new VARCHAR column
ALTER TABLE memory_relations ADD COLUMN IF NOT EXISTS relation_type_new VARCHAR(50);

-- Copy data from ENUM to VARCHAR
UPDATE memory_relations SET relation_type_new = relation_type::text WHERE relation_type_new IS NULL;

-- Drop the old ENUM column and rename the new one
ALTER TABLE memory_relations DROP COLUMN IF EXISTS relation_type;
ALTER TABLE memory_relations RENAME COLUMN relation_type_new TO relation_type;

-- Add NOT NULL constraint and foreign key
ALTER TABLE memory_relations ALTER COLUMN relation_type SET NOT NULL;
ALTER TABLE memory_relations ADD CONSTRAINT fk_relation_type
  FOREIGN KEY (relation_type) REFERENCES relation_types(value);

-- Re-create the unique constraint and index
ALTER TABLE memory_relations ADD CONSTRAINT memory_relations_source_memory_id_target_memory_id_relation_key
  UNIQUE (source_memory_id, target_memory_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_memory_relations_type ON memory_relations(relation_type);

-- Recreate the view with VARCHAR relation_type
CREATE OR REPLACE VIEW memory_relations_expanded AS
SELECT
  r.id AS relation_id,
  r.relation_type,
  r.created_at,
  s.id AS source_id,
  s.handle AS source_handle,
  s.title AS source_title,
  smt.name AS source_type,
  sp.handle AS source_project_handle,
  t.id AS target_id,
  t.handle AS target_handle,
  t.title AS target_title,
  tmt.name AS target_type,
  tp.handle AS target_project_handle
FROM memory_relations r
JOIN memories s ON s.id = r.source_memory_id
JOIN memories t ON t.id = r.target_memory_id
JOIN memory_types smt ON smt.id = s.memory_type_id
JOIN memory_types tmt ON tmt.id = t.memory_type_id
JOIN projects sp ON sp.id = s.project_id
JOIN projects tp ON tp.id = t.project_id;

-- Step 4: Add blocked and on_hold statuses to todo types
-- Get the memory type IDs for user-todo and agent-todo
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, sort_order)
SELECT mt.id, 'blocked', 'Blocked', 90
FROM memory_types mt
WHERE mt.name IN ('user-todo', 'agent-todo')
ON CONFLICT (memory_type_id, status_value) DO NOTHING;

INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, sort_order)
SELECT mt.id, 'on_hold', 'On Hold', 80
FROM memory_types mt
WHERE mt.name IN ('user-todo', 'agent-todo')
ON CONFLICT (memory_type_id, status_value) DO NOTHING;

-- DOWN

-- Remove blocked and on_hold statuses
DELETE FROM memory_type_statuses WHERE status_value IN ('blocked', 'on_hold');

-- Revert memory_relations.relation_type back to ENUM
-- First, drop the view
DROP VIEW IF EXISTS memory_relations_expanded;

-- Drop new constraints and indexes
ALTER TABLE memory_relations DROP CONSTRAINT IF EXISTS memory_relations_source_memory_id_target_memory_id_relation_key;
DROP INDEX IF EXISTS idx_memory_relations_type;
ALTER TABLE memory_relations DROP CONSTRAINT IF EXISTS fk_relation_type;

-- Add ENUM column back, copy data, swap columns
-- Note: Only existing ENUM values can be restored; new types will cause errors
ALTER TABLE memory_relations ADD COLUMN IF NOT EXISTS relation_type_old relation_type;
UPDATE memory_relations SET relation_type_old = relation_type::relation_type;
ALTER TABLE memory_relations DROP COLUMN IF EXISTS relation_type;
ALTER TABLE memory_relations RENAME COLUMN relation_type_old TO relation_type;
ALTER TABLE memory_relations ALTER COLUMN relation_type SET NOT NULL;

-- Re-create original constraints and indexes
ALTER TABLE memory_relations ADD CONSTRAINT memory_relations_source_memory_id_target_memory_id_relation_key
  UNIQUE (source_memory_id, target_memory_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_memory_relations_type ON memory_relations(relation_type);

-- Recreate the view with ENUM relation_type
CREATE OR REPLACE VIEW memory_relations_expanded AS
SELECT
  r.id AS relation_id,
  r.relation_type,
  r.created_at,
  s.id AS source_id,
  s.handle AS source_handle,
  s.title AS source_title,
  smt.name AS source_type,
  sp.handle AS source_project_handle,
  t.id AS target_id,
  t.handle AS target_handle,
  t.title AS target_title,
  tmt.name AS target_type,
  tp.handle AS target_project_handle
FROM memory_relations r
JOIN memories s ON s.id = r.source_memory_id
JOIN memories t ON t.id = r.target_memory_id
JOIN memory_types smt ON smt.id = s.memory_type_id
JOIN memory_types tmt ON tmt.id = t.memory_type_id
JOIN projects sp ON sp.id = s.project_id
JOIN projects tp ON tp.id = t.project_id;

-- Drop relation_types table
DROP TABLE IF EXISTS relation_types;
