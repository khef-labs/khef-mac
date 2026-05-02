-- Migration: Require dbx.saved_queries.connection_id; cascade on connection delete
-- Created: 2026-05-01
--
-- Saved queries must always be bound to a real connection. Existing null-bound
-- rows are migrated to the builtin connection. The FK action changes from
-- SET NULL to CASCADE so deleting a connection removes its saved queries.

-- UP

-- 1. Backfill: any null connection_id → builtin connection id.
UPDATE dbx.saved_queries
SET connection_id = (SELECT id FROM dbx.connections WHERE is_builtin = true LIMIT 1)
WHERE connection_id IS NULL;

-- 2. NOT NULL constraint.
ALTER TABLE dbx.saved_queries
  ALTER COLUMN connection_id SET NOT NULL;

-- 3. Replace the FK with ON DELETE CASCADE.
ALTER TABLE dbx.saved_queries
  DROP CONSTRAINT saved_queries_connection_id_fkey;

ALTER TABLE dbx.saved_queries
  ADD CONSTRAINT saved_queries_connection_id_fkey
  FOREIGN KEY (connection_id) REFERENCES dbx.connections(id) ON DELETE CASCADE;

-- 4. Replace the COALESCE-based unique index with a plain (connection_id, handle).
DROP INDEX IF EXISTS dbx.idx_dbx_saved_queries_handle_per_conn;

CREATE UNIQUE INDEX idx_dbx_saved_queries_handle_per_conn
  ON dbx.saved_queries (connection_id, handle);

-- DOWN

-- Restore the COALESCE-based unique index.
DROP INDEX IF EXISTS dbx.idx_dbx_saved_queries_handle_per_conn;

CREATE UNIQUE INDEX idx_dbx_saved_queries_handle_per_conn
  ON dbx.saved_queries (COALESCE(connection_id::text, ''), handle);

-- Restore SET NULL.
ALTER TABLE dbx.saved_queries
  DROP CONSTRAINT saved_queries_connection_id_fkey;

ALTER TABLE dbx.saved_queries
  ADD CONSTRAINT saved_queries_connection_id_fkey
  FOREIGN KEY (connection_id) REFERENCES dbx.connections(id) ON DELETE SET NULL;

-- Allow nulls again.
ALTER TABLE dbx.saved_queries
  ALTER COLUMN connection_id DROP NOT NULL;
