-- Migration: Decouple kapi from public.projects via kapi.collections
-- Created: 2026-04-20T00:51:39.000Z
--
-- Replaces the per-project ownership model with a dedicated kapi.collections
-- table. Existing definitions/scripts/environments/runs are migrated by
-- creating one collection per distinct project_id, mirroring the project's
-- handle and name. Once backfilled, project_id columns and FKs are dropped.

-- UP

-- ---------------------------------------------------------------------------
-- kapi.collections  (top-level grouping; no FK to public.projects)
-- ---------------------------------------------------------------------------
CREATE TABLE kapi.collections (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  handle      VARCHAR(100) NOT NULL UNIQUE,
  name        VARCHAR(200) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT kapi_collections_handle_format CHECK (handle ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

CREATE INDEX idx_kapi_collections_updated ON kapi.collections(updated_at DESC);

CREATE TRIGGER update_kapi_collections_updated_at
  BEFORE UPDATE ON kapi.collections
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Add nullable collection_id columns to existing kapi tables
-- ---------------------------------------------------------------------------
ALTER TABLE kapi.definitions   ADD COLUMN collection_id UUID REFERENCES kapi.collections(id) ON DELETE CASCADE;
ALTER TABLE kapi.scripts       ADD COLUMN collection_id UUID REFERENCES kapi.collections(id) ON DELETE CASCADE;
ALTER TABLE kapi.environments  ADD COLUMN collection_id UUID REFERENCES kapi.collections(id) ON DELETE CASCADE;
ALTER TABLE kapi.runs          ADD COLUMN collection_id UUID REFERENCES kapi.collections(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Backfill: one kapi.collection per distinct project_id seen across the
-- four owning tables. Reuse the project's handle/name so existing references
-- continue to feel familiar. Handle collisions (e.g. a collection already
-- exists with the same handle) are avoided because no rows exist yet.
-- ---------------------------------------------------------------------------
INSERT INTO kapi.collections (id, handle, name, description)
SELECT
  uuid_generate_v7(),
  p.handle,
  p.name,
  'Migrated from project: ' || p.handle
FROM public.projects p
WHERE p.id IN (
  SELECT project_id FROM kapi.definitions
  UNION
  SELECT project_id FROM kapi.scripts
  UNION
  SELECT project_id FROM kapi.environments
  UNION
  SELECT project_id FROM kapi.runs
);

-- Map project_id → collection_id by handle and update each table
UPDATE kapi.definitions d
SET collection_id = c.id
FROM public.projects p
JOIN kapi.collections c ON c.handle = p.handle
WHERE d.project_id = p.id;

UPDATE kapi.scripts s
SET collection_id = c.id
FROM public.projects p
JOIN kapi.collections c ON c.handle = p.handle
WHERE s.project_id = p.id;

UPDATE kapi.environments e
SET collection_id = c.id
FROM public.projects p
JOIN kapi.collections c ON c.handle = p.handle
WHERE e.project_id = p.id;

UPDATE kapi.runs r
SET collection_id = c.id
FROM public.projects p
JOIN kapi.collections c ON c.handle = p.handle
WHERE r.project_id = p.id;

-- ---------------------------------------------------------------------------
-- Drop old project-scoped constraints and indexes
-- ---------------------------------------------------------------------------
ALTER TABLE kapi.definitions  DROP CONSTRAINT kapi_definitions_unique_handle;
ALTER TABLE kapi.environments DROP CONSTRAINT kapi_environments_unique_handle;

DROP INDEX IF EXISTS kapi.idx_kapi_definitions_project;
DROP INDEX IF EXISTS kapi.idx_kapi_scripts_unique_handle;
DROP INDEX IF EXISTS kapi.idx_kapi_scripts_project;
DROP INDEX IF EXISTS kapi.idx_kapi_environments_one_active;
DROP INDEX IF EXISTS kapi.idx_kapi_environments_project;
DROP INDEX IF EXISTS kapi.idx_kapi_runs_project_executed;

-- ---------------------------------------------------------------------------
-- Drop project_id columns (CASCADE drops the FKs)
-- ---------------------------------------------------------------------------
ALTER TABLE kapi.definitions   DROP COLUMN project_id;
ALTER TABLE kapi.scripts       DROP COLUMN project_id;
ALTER TABLE kapi.environments  DROP COLUMN project_id;
ALTER TABLE kapi.runs          DROP COLUMN project_id;

-- ---------------------------------------------------------------------------
-- Make collection_id NOT NULL on tables where it must always be set
-- ---------------------------------------------------------------------------
ALTER TABLE kapi.definitions   ALTER COLUMN collection_id SET NOT NULL;
ALTER TABLE kapi.scripts       ALTER COLUMN collection_id SET NOT NULL;
ALTER TABLE kapi.environments  ALTER COLUMN collection_id SET NOT NULL;
ALTER TABLE kapi.runs          ALTER COLUMN collection_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Recreate uniques + indexes scoped to collection_id
-- ---------------------------------------------------------------------------
ALTER TABLE kapi.definitions
  ADD CONSTRAINT kapi_definitions_unique_handle UNIQUE (collection_id, handle);

ALTER TABLE kapi.environments
  ADD CONSTRAINT kapi_environments_unique_handle UNIQUE (collection_id, handle);

CREATE INDEX idx_kapi_definitions_collection  ON kapi.definitions(collection_id);
CREATE INDEX idx_kapi_scripts_collection      ON kapi.scripts(collection_id);
CREATE INDEX idx_kapi_environments_collection ON kapi.environments(collection_id);
CREATE INDEX idx_kapi_runs_collection_executed
  ON kapi.runs(collection_id, executed_at DESC);

CREATE UNIQUE INDEX idx_kapi_scripts_unique_handle
  ON kapi.scripts(collection_id, handle)
  WHERE handle IS NOT NULL;

-- One active environment per collection
CREATE UNIQUE INDEX idx_kapi_environments_one_active
  ON kapi.environments(collection_id)
  WHERE is_active = TRUE;

-- DOWN

-- Re-add project_id columns (nullable for backfill)
ALTER TABLE kapi.definitions   ADD COLUMN project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE;
ALTER TABLE kapi.scripts       ADD COLUMN project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE;
ALTER TABLE kapi.environments  ADD COLUMN project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE;
ALTER TABLE kapi.runs          ADD COLUMN project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE;

-- Map collection.handle back to project.handle
UPDATE kapi.definitions d
SET project_id = p.id
FROM kapi.collections c
JOIN public.projects p ON p.handle = c.handle
WHERE d.collection_id = c.id;

UPDATE kapi.scripts s
SET project_id = p.id
FROM kapi.collections c
JOIN public.projects p ON p.handle = c.handle
WHERE s.collection_id = c.id;

UPDATE kapi.environments e
SET project_id = p.id
FROM kapi.collections c
JOIN public.projects p ON p.handle = c.handle
WHERE e.collection_id = c.id;

UPDATE kapi.runs r
SET project_id = p.id
FROM kapi.collections c
JOIN public.projects p ON p.handle = c.handle
WHERE r.collection_id = c.id;

-- Drop collection-scoped uniques + indexes
ALTER TABLE kapi.definitions  DROP CONSTRAINT kapi_definitions_unique_handle;
ALTER TABLE kapi.environments DROP CONSTRAINT kapi_environments_unique_handle;
DROP INDEX IF EXISTS kapi.idx_kapi_scripts_unique_handle;
DROP INDEX IF EXISTS kapi.idx_kapi_environments_one_active;
DROP INDEX IF EXISTS kapi.idx_kapi_definitions_collection;
DROP INDEX IF EXISTS kapi.idx_kapi_scripts_collection;
DROP INDEX IF EXISTS kapi.idx_kapi_environments_collection;
DROP INDEX IF EXISTS kapi.idx_kapi_runs_collection_executed;

-- Drop collection_id columns
ALTER TABLE kapi.definitions   DROP COLUMN collection_id;
ALTER TABLE kapi.scripts       DROP COLUMN collection_id;
ALTER TABLE kapi.environments  DROP COLUMN collection_id;
ALTER TABLE kapi.runs          DROP COLUMN collection_id;

-- Restore NOT NULL on project_id and original constraints/indexes
ALTER TABLE kapi.definitions   ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE kapi.scripts       ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE kapi.environments  ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE kapi.runs          ALTER COLUMN project_id SET NOT NULL;

ALTER TABLE kapi.definitions
  ADD CONSTRAINT kapi_definitions_unique_handle UNIQUE (project_id, handle);
ALTER TABLE kapi.environments
  ADD CONSTRAINT kapi_environments_unique_handle UNIQUE (project_id, handle);

CREATE INDEX idx_kapi_definitions_project ON kapi.definitions(project_id);
CREATE INDEX idx_kapi_scripts_project     ON kapi.scripts(project_id);
CREATE UNIQUE INDEX idx_kapi_scripts_unique_handle
  ON kapi.scripts(project_id, handle)
  WHERE handle IS NOT NULL;
CREATE INDEX idx_kapi_environments_project ON kapi.environments(project_id);
CREATE UNIQUE INDEX idx_kapi_environments_one_active
  ON kapi.environments(project_id)
  WHERE is_active = TRUE;
CREATE INDEX idx_kapi_runs_project_executed ON kapi.runs(project_id, executed_at DESC);

DROP TRIGGER IF EXISTS update_kapi_collections_updated_at ON kapi.collections;
DROP TABLE IF EXISTS kapi.collections;
