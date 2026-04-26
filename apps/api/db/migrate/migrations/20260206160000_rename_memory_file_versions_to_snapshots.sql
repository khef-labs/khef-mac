-- UP
-- Rename table
ALTER TABLE assistant_memory_file_versions RENAME TO assistant_memory_file_snapshots;

-- Rename columns
ALTER TABLE assistant_memory_file_snapshots RENAME COLUMN version TO snapshot_number;
ALTER TABLE assistant_memory_files RENAME COLUMN current_version TO current_snapshot;

-- Rename indexes
ALTER INDEX idx_amfv_file RENAME TO idx_amfs_file;
ALTER INDEX idx_amfv_hash RENAME TO idx_amfs_hash;

-- Rename unique constraint (PostgreSQL auto-generated name from UNIQUE constraint)
ALTER TABLE assistant_memory_file_snapshots
  RENAME CONSTRAINT assistant_memory_file_versions_memory_file_id_version_key
  TO assistant_memory_file_snapshots_memory_file_id_snapshot_number_key;

-- DOWN
-- Revert unique constraint name
ALTER TABLE assistant_memory_file_snapshots
  RENAME CONSTRAINT assistant_memory_file_snapshots_memory_file_id_snapshot_number_key
  TO assistant_memory_file_versions_memory_file_id_version_key;

-- Revert indexes
ALTER INDEX idx_amfs_file RENAME TO idx_amfv_file;
ALTER INDEX idx_amfs_hash RENAME TO idx_amfv_hash;

-- Revert columns
ALTER TABLE assistant_memory_files RENAME COLUMN current_snapshot TO current_version;
ALTER TABLE assistant_memory_file_snapshots RENAME COLUMN snapshot_number TO version;

-- Revert table name
ALTER TABLE assistant_memory_file_snapshots RENAME TO assistant_memory_file_versions;
