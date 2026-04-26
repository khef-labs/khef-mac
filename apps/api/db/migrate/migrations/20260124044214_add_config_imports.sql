-- Migration: Add support for tracking imported config files
-- When a config references @~/path/to/file.md, we create a linked config entry

-- Add columns to track import relationships
ALTER TABLE configs ADD COLUMN parent_config_id UUID REFERENCES configs(id) ON DELETE CASCADE;
ALTER TABLE configs ADD COLUMN is_import BOOLEAN DEFAULT false;

-- Index for querying imports of a config
CREATE INDEX idx_configs_parent ON configs(parent_config_id) WHERE parent_config_id IS NOT NULL;

-- DOWN

DROP INDEX IF EXISTS idx_configs_parent;
ALTER TABLE configs DROP COLUMN IF EXISTS is_import;
ALTER TABLE configs DROP COLUMN IF EXISTS parent_config_id;
