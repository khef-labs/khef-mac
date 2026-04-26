-- UP
-- Config snapshots: preserve content history for assistant configurations
-- Follows the memory snapshots pattern with sequential snapshot_number
-- Note: current_snapshot is computed from MAX(snapshot_number), not stored

CREATE TABLE IF NOT EXISTS config_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id UUID NOT NULL REFERENCES configs(id) ON DELETE CASCADE,
  snapshot_number INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source VARCHAR(50) NOT NULL DEFAULT 'manual', -- 'manual', 'import', 'pre-sync'
  size INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(config_id, snapshot_number)
);

CREATE INDEX IF NOT EXISTS idx_config_snapshots_config ON config_snapshots(config_id);
CREATE INDEX IF NOT EXISTS idx_config_snapshots_hash ON config_snapshots(content_hash);

-- Seed initial snapshots from current config content
INSERT INTO config_snapshots (config_id, snapshot_number, content, content_hash, source, size)
SELECT
  id,
  1,
  content,
  COALESCE(file_hash, encode(sha256(content::bytea), 'hex')),
  'manual',
  LENGTH(content)
FROM configs c
WHERE content IS NOT NULL
  AND content != ''
  AND NOT EXISTS (
    SELECT 1 FROM config_snapshots cs WHERE cs.config_id = c.id
  );

-- DOWN
DROP TABLE IF EXISTS config_snapshots;
