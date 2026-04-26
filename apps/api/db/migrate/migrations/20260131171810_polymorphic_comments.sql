-- Migration: Make comments polymorphic for memories and plans
-- Adds entity_type/entity_id columns, migrates existing data, drops memory_id FK
-- Also adds updated_by column to track who last edited a comment

-- UP

-- Add polymorphic entity columns
ALTER TABLE comments
  ADD COLUMN entity_type VARCHAR(50),
  ADD COLUMN entity_id UUID,
  ADD COLUMN updated_by VARCHAR(50);

-- Migrate existing memory comments
UPDATE comments SET entity_type = 'memory', entity_id = memory_id;

-- Make new columns required
ALTER TABLE comments
  ALTER COLUMN entity_type SET NOT NULL,
  ALTER COLUMN entity_id SET NOT NULL;

-- Drop old memory_id FK and column
ALTER TABLE comments
  DROP CONSTRAINT comments_memory_id_fkey;

DROP INDEX IF EXISTS idx_comments_memory_id;

ALTER TABLE comments
  DROP COLUMN memory_id;

-- Create new indexes for polymorphic lookup
CREATE INDEX idx_comments_entity ON comments(entity_type, entity_id);

-- DOWN

-- Add memory_id column back
ALTER TABLE comments
  ADD COLUMN memory_id UUID;

-- Migrate data back (only memory comments can be restored)
UPDATE comments SET memory_id = entity_id WHERE entity_type = 'memory';

-- Re-add FK constraint
ALTER TABLE comments
  ADD CONSTRAINT comments_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE;

-- Re-create index
CREATE INDEX idx_comments_memory_id ON comments(memory_id);

-- Drop new columns and index
DROP INDEX IF EXISTS idx_comments_entity;
ALTER TABLE comments
  DROP COLUMN updated_by,
  DROP COLUMN entity_id,
  DROP COLUMN entity_type;
