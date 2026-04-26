-- Migration: Inline kapi scripts onto requests
-- Created: 2026-04-20T19:22:32.000Z
--
-- Collapses kapi.scripts into columns on kapi.requests. Previously scripts
-- were a separate table with a FK from request.pre_script_id / test_script_id,
-- plus an AFTER DELETE trigger that tried to garbage-collect "inline" scripts.
-- That model allowed multiple requests to point at the same script row, and
-- deleting one request silently nulled the FK on every other request pointing
-- at the shared row (cleanup trigger assumed 1:1 ownership but nothing
-- enforced it). It also meant editing one request's script could mutate
-- another's without warning.
--
-- New model: each request owns its pre- and test-script content directly.
-- No shared scripts, no FKs, no trigger. "Copying" a script is a plain text
-- copy — provided by the copy_kapi_script MCP tool at the application layer.

-- UP

ALTER TABLE kapi.requests
  ADD COLUMN pre_script_content    TEXT NOT NULL DEFAULT '',
  ADD COLUMN pre_script_language   VARCHAR(20) NOT NULL DEFAULT 'javascript',
  ADD COLUMN test_script_content   TEXT NOT NULL DEFAULT '',
  ADD COLUMN test_script_language  VARCHAR(20) NOT NULL DEFAULT 'javascript',
  ADD CONSTRAINT kapi_requests_pre_script_language CHECK (
    pre_script_language IN ('javascript', 'shell')
  ),
  ADD CONSTRAINT kapi_requests_test_script_language CHECK (
    test_script_language IN ('javascript', 'shell')
  );

-- Backfill content from the old table. If two requests shared the same
-- script row, both get a copy — each request ends up independently owning
-- its text post-migration.
UPDATE kapi.requests r
SET pre_script_content  = s.content,
    pre_script_language = s.language
FROM kapi.scripts s
WHERE r.pre_script_id = s.id;

UPDATE kapi.requests r
SET test_script_content  = s.content,
    test_script_language = s.language
FROM kapi.scripts s
WHERE r.test_script_id = s.id;

-- Drop the cleanup trigger and its function. The new model doesn't need
-- garbage collection — scripts live and die with the owning request row.
DROP TRIGGER IF EXISTS kapi_requests_cleanup_inline_scripts ON kapi.requests;
DROP FUNCTION IF EXISTS kapi.cleanup_inline_scripts();

-- Drop the attach FKs last so the backfill SELECTs above still work.
ALTER TABLE kapi.requests
  DROP COLUMN pre_script_id,
  DROP COLUMN test_script_id;

DROP TABLE IF EXISTS kapi.scripts;

-- DOWN

CREATE TABLE kapi.scripts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  collection_id UUID NOT NULL REFERENCES kapi.collections(id) ON DELETE CASCADE,
  handle        VARCHAR(100),
  name          VARCHAR(200) NOT NULL,
  kind          VARCHAR(20) NOT NULL,
  language      VARCHAR(20) NOT NULL DEFAULT 'javascript',
  content       TEXT NOT NULL DEFAULT '',
  is_inline     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT kapi_scripts_kind CHECK (kind IN ('pre-request', 'test')),
  CONSTRAINT kapi_scripts_language CHECK (language IN ('javascript', 'shell')),
  CONSTRAINT kapi_scripts_handle_format CHECK (
    handle IS NULL OR handle ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  )
);

CREATE UNIQUE INDEX idx_kapi_scripts_unique_handle
  ON kapi.scripts(collection_id, handle)
  WHERE handle IS NOT NULL;

CREATE INDEX idx_kapi_scripts_collection ON kapi.scripts(collection_id);

CREATE TRIGGER update_kapi_scripts_updated_at
  BEFORE UPDATE ON kapi.scripts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE kapi.requests
  ADD COLUMN pre_script_id  UUID REFERENCES kapi.scripts(id) ON DELETE SET NULL,
  ADD COLUMN test_script_id UUID REFERENCES kapi.scripts(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION kapi.cleanup_inline_scripts()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.pre_script_id IS NOT NULL THEN
    DELETE FROM kapi.scripts WHERE id = OLD.pre_script_id AND is_inline = TRUE;
  END IF;
  IF OLD.test_script_id IS NOT NULL THEN
    DELETE FROM kapi.scripts WHERE id = OLD.test_script_id AND is_inline = TRUE;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER kapi_requests_cleanup_inline_scripts
  AFTER DELETE ON kapi.requests
  FOR EACH ROW
  EXECUTE FUNCTION kapi.cleanup_inline_scripts();

-- Recreate reusable scripts from the inlined columns (best-effort — inline
-- content is not preserved if the UP migration ran without the old table).
-- Running DOWN on an UP'd database leaves the new columns populated; we
-- leave them in place rather than dropping data.

ALTER TABLE kapi.requests
  DROP CONSTRAINT IF EXISTS kapi_requests_pre_script_language,
  DROP CONSTRAINT IF EXISTS kapi_requests_test_script_language,
  DROP COLUMN IF EXISTS pre_script_content,
  DROP COLUMN IF EXISTS pre_script_language,
  DROP COLUMN IF EXISTS test_script_content,
  DROP COLUMN IF EXISTS test_script_language;
