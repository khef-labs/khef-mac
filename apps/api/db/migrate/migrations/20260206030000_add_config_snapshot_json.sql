-- UP
-- Add content_type to config_snapshots to track format (json, markdown, toml)

ALTER TABLE config_snapshots ADD COLUMN IF NOT EXISTS content_type VARCHAR(20);

-- Backfill content_type from configs table
UPDATE config_snapshots cs
SET content_type = c.format
FROM configs c
WHERE cs.config_id = c.id
  AND cs.content_type IS NULL;

-- DOWN
ALTER TABLE config_snapshots DROP COLUMN IF EXISTS content_type;
