-- UP
-- Add content_json JSONB column for JSON config snapshots
-- Guarantees validity at DB level and enables JSON querying

ALTER TABLE config_snapshots ADD COLUMN IF NOT EXISTS content_json JSONB;

-- Backfill content_json for existing JSON snapshots
UPDATE config_snapshots
SET content_json = content::jsonb
WHERE content_type = 'json'
  AND content_json IS NULL
  AND content IS NOT NULL
  AND content != '';

-- DOWN
ALTER TABLE config_snapshots DROP COLUMN IF EXISTS content_json;
