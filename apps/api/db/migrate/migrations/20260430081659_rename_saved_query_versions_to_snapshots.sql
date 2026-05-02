-- Migration: Rename saved_query_versions to saved_query_snapshots
-- Created: 2026-04-30T13:16:59.604Z
--
-- Aligns saved-query history with the memory_snapshots model: editing the SQL
-- no longer auto-creates a snapshot (PATCH just updates the live row).
-- Snapshots are now point-in-time captures created either manually by the
-- user or as a pre-restore safety net.

-- UP

ALTER TABLE dbx.saved_query_versions RENAME TO saved_query_snapshots;
ALTER TABLE dbx.saved_query_snapshots RENAME COLUMN version TO snapshot_number;

ALTER TABLE dbx.saved_query_snapshots
  ADD COLUMN source VARCHAR(50) NOT NULL DEFAULT 'manual';
ALTER TABLE dbx.saved_query_snapshots
  ADD CONSTRAINT dbx_saved_query_snapshots_source CHECK (source IN ('manual','pre-restore'));

-- The unique index + pk names were tied to the old table name. Rename them so
-- they line up with the new identifier (Postgres doesn't auto-rename these).
ALTER INDEX IF EXISTS dbx.saved_query_versions_query_id_version_key RENAME TO saved_query_snapshots_query_id_snapshot_number_key;
ALTER INDEX IF EXISTS dbx.saved_query_versions_pkey RENAME TO saved_query_snapshots_pkey;

DROP INDEX IF EXISTS dbx.idx_dbx_saved_query_versions_query;
CREATE INDEX idx_dbx_saved_query_snapshots_query
  ON dbx.saved_query_snapshots (query_id, snapshot_number DESC);

-- The version counter on saved_queries is no longer maintained — snapshot
-- numbering lives on the snapshots table.
ALTER TABLE dbx.saved_queries DROP COLUMN IF EXISTS version;

-- DOWN

ALTER TABLE dbx.saved_queries ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

DROP INDEX IF EXISTS dbx.idx_dbx_saved_query_snapshots_query;
CREATE INDEX idx_dbx_saved_query_versions_query
  ON dbx.saved_query_snapshots (query_id, snapshot_number DESC);

ALTER INDEX IF EXISTS dbx.saved_query_snapshots_pkey RENAME TO saved_query_versions_pkey;
ALTER INDEX IF EXISTS dbx.saved_query_snapshots_query_id_snapshot_number_key RENAME TO saved_query_versions_query_id_version_key;

ALTER TABLE dbx.saved_query_snapshots DROP CONSTRAINT IF EXISTS dbx_saved_query_snapshots_source;
ALTER TABLE dbx.saved_query_snapshots DROP COLUMN IF EXISTS source;

ALTER TABLE dbx.saved_query_snapshots RENAME COLUMN snapshot_number TO version;
ALTER TABLE dbx.saved_query_snapshots RENAME TO saved_query_versions;
