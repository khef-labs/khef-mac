-- Migration: Decouple tracked_files from snapshots
-- Files exist once per (collection, repo, file_path) instead of per-snapshot.
-- A new snapshot_files join table links files to the commits that include them.
-- This eliminates duplicate chunks when the same file appears in multiple commits.

-- UP

-- Create join table: files 1:N snapshots
CREATE TABLE kvec.snapshot_files (
    snapshot_id  uuid NOT NULL REFERENCES kvec.snapshots(id) ON DELETE CASCADE,
    file_id      uuid NOT NULL REFERENCES kvec.tracked_files(id) ON DELETE CASCADE,
    PRIMARY KEY (snapshot_id, file_id)
);

CREATE INDEX idx_kvec_snapshot_files_file ON kvec.snapshot_files(file_id);

-- Migrate existing snapshot_id references to the join table
INSERT INTO kvec.snapshot_files (snapshot_id, file_id)
SELECT snapshot_id, id FROM kvec.tracked_files
WHERE snapshot_id IS NOT NULL;

-- Deduplicate tracked_files: keep the most recent row per (collection, repo, file_path).
-- Older duplicates and their chunks cascade-delete.
DELETE FROM kvec.tracked_files
WHERE id IN (
  SELECT id FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY collection_id, repo_id, file_path
        ORDER BY updated_at DESC
      ) as rn
    FROM kvec.tracked_files
  ) ranked
  WHERE rn > 1
);

-- Drop views that depend on snapshot_id before altering column
DROP VIEW IF EXISTS kvec.collection_stats;
DROP VIEW IF EXISTS kvec.tracked_files_stats;

-- Drop old unique constraint that included snapshot_id
ALTER TABLE kvec.tracked_files
  DROP CONSTRAINT IF EXISTS tracked_files_collection_id_repo_id_file_path_snapshot_id_key;

-- Drop snapshot_id column (data already migrated to join table)
ALTER TABLE kvec.tracked_files DROP COLUMN snapshot_id;

-- Add new unique constraint without snapshot
ALTER TABLE kvec.tracked_files
  ADD CONSTRAINT tracked_files_collection_repo_filepath_uk
  UNIQUE NULLS NOT DISTINCT (collection_id, repo_id, file_path);

CREATE VIEW kvec.tracked_files_stats AS
SELECT f.*,
    COUNT(c.id) AS chunk_count,
    COALESCE(SUM(c.token_count), 0) AS total_token_count,
    array_agg(DISTINCT c.chunk_method) FILTER (WHERE c.chunk_method IS NOT NULL) AS chunk_methods
FROM kvec.tracked_files f
LEFT JOIN kvec.chunks c ON c.file_id = f.id
GROUP BY f.id;

CREATE VIEW kvec.collection_stats AS
SELECT col.*,
    COUNT(DISTINCT f.id) AS file_count,
    COUNT(ch.id) AS total_chunks,
    COALESCE(SUM(DISTINCT f.file_size), 0) AS total_bytes,
    COUNT(DISTINCT r.id) AS repo_count,
    COUNT(DISTINCT s.branch) AS branch_count,
    MAX(f.updated_at) AS last_upload
FROM kvec.collections col
LEFT JOIN kvec.tracked_files f ON f.collection_id = col.id
LEFT JOIN kvec.chunks ch ON ch.file_id = f.id
LEFT JOIN kvec.repos r ON r.collection_id = col.id
LEFT JOIN kvec.snapshot_files sf ON sf.file_id = f.id
LEFT JOIN kvec.snapshots s ON s.id = sf.snapshot_id
GROUP BY col.id;

-- DOWN

DROP VIEW IF EXISTS kvec.collection_stats;
DROP VIEW IF EXISTS kvec.tracked_files_stats;

ALTER TABLE kvec.tracked_files
  DROP CONSTRAINT IF EXISTS tracked_files_collection_repo_filepath_uk;

ALTER TABLE kvec.tracked_files
  ADD COLUMN snapshot_id uuid REFERENCES kvec.snapshots(id);

-- Restore snapshot_id from join table (pick latest snapshot per file)
UPDATE kvec.tracked_files f
SET snapshot_id = sf.snapshot_id
FROM (
  SELECT DISTINCT ON (file_id) file_id, snapshot_id
  FROM kvec.snapshot_files
  ORDER BY file_id, snapshot_id DESC
) sf
WHERE f.id = sf.file_id;

ALTER TABLE kvec.tracked_files
  ADD CONSTRAINT tracked_files_collection_id_repo_id_file_path_snapshot_id_key
  UNIQUE NULLS NOT DISTINCT (collection_id, repo_id, file_path, snapshot_id);

DROP INDEX IF EXISTS kvec.idx_kvec_snapshot_files_file;
DROP TABLE IF EXISTS kvec.snapshot_files;

CREATE VIEW kvec.tracked_files_stats AS
SELECT f.*,
    COUNT(c.id) AS chunk_count,
    COALESCE(SUM(c.token_count), 0) AS total_token_count,
    array_agg(DISTINCT c.chunk_method) FILTER (WHERE c.chunk_method IS NOT NULL) AS chunk_methods
FROM kvec.tracked_files f
LEFT JOIN kvec.chunks c ON c.file_id = f.id
GROUP BY f.id;

CREATE VIEW kvec.collection_stats AS
SELECT col.*,
    COUNT(DISTINCT f.id) AS file_count,
    COUNT(ch.id) AS total_chunks,
    COALESCE(SUM(DISTINCT f.file_size), 0) AS total_bytes,
    COUNT(DISTINCT r.id) AS repo_count,
    COUNT(DISTINCT s.branch) AS branch_count,
    MAX(f.updated_at) AS last_upload
FROM kvec.collections col
LEFT JOIN kvec.tracked_files f ON f.collection_id = col.id
LEFT JOIN kvec.chunks ch ON ch.file_id = f.id
LEFT JOIN kvec.repos r ON r.collection_id = col.id
LEFT JOIN kvec.snapshots s ON s.id = f.snapshot_id
GROUP BY col.id;
