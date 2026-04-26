-- Migration: Deduplicate configs by path and add unique constraint
-- Created: 2026-01-29

-- UP

-- Delete duplicate configs, keeping the one with the earliest created_at
DELETE FROM configs
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY path ORDER BY created_at) as rn
    FROM configs
  ) t WHERE rn > 1
);

-- Add unique constraint on path to prevent future duplicates
ALTER TABLE configs ADD CONSTRAINT configs_path_unique UNIQUE (path);

-- DOWN

-- Remove unique constraint
ALTER TABLE configs DROP CONSTRAINT IF EXISTS configs_path_unique;

-- Note: Cannot restore deleted duplicates
