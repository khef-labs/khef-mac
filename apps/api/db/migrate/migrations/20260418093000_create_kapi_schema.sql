-- Migration: Create kapi schema
-- Created: 2026-04-18T09:30:00.000Z
--
-- Adds the kapi schema and seven tables backing the built-in API tool.
-- Definitions group requests; requests own optional pre/test scripts;
-- environments hold vars (secrets encrypted at rest); runs are an
-- append-only log of every execution.

-- UP

CREATE SCHEMA IF NOT EXISTS kapi;

-- ---------------------------------------------------------------------------
-- kapi.definitions  (collections of requests)
-- ---------------------------------------------------------------------------
CREATE TABLE kapi.definitions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id      UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  handle          VARCHAR(100) NOT NULL,
  name            VARCHAR(200) NOT NULL,
  description     TEXT,
  base_url        TEXT,
  default_auth    JSONB NOT NULL DEFAULT '{}'::jsonb,
  openapi_source  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT kapi_definitions_handle_format CHECK (handle ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT kapi_definitions_unique_handle UNIQUE (project_id, handle)
);

CREATE INDEX idx_kapi_definitions_project ON kapi.definitions(project_id);
CREATE INDEX idx_kapi_definitions_updated ON kapi.definitions(updated_at DESC);

CREATE TRIGGER update_kapi_definitions_updated_at
  BEFORE UPDATE ON kapi.definitions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- kapi.request_folders  (optional nesting within a definition)
-- ---------------------------------------------------------------------------
CREATE TABLE kapi.request_folders (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  definition_id  UUID NOT NULL REFERENCES kapi.definitions(id) ON DELETE CASCADE,
  parent_id      UUID REFERENCES kapi.request_folders(id) ON DELETE CASCADE,
  name           VARCHAR(200) NOT NULL,
  order_index    INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kapi_request_folders_definition ON kapi.request_folders(definition_id);
CREATE INDEX idx_kapi_request_folders_parent ON kapi.request_folders(parent_id);

CREATE TRIGGER update_kapi_request_folders_updated_at
  BEFORE UPDATE ON kapi.request_folders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- kapi.scripts  (reusable or inline pre-request / test scripts)
-- ---------------------------------------------------------------------------
CREATE TABLE kapi.scripts (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id   UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  handle       VARCHAR(100),
  name         VARCHAR(200) NOT NULL,
  kind         VARCHAR(20) NOT NULL,
  language     VARCHAR(20) NOT NULL DEFAULT 'javascript',
  content      TEXT NOT NULL DEFAULT '',
  is_inline    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT kapi_scripts_kind CHECK (kind IN ('pre-request', 'test')),
  CONSTRAINT kapi_scripts_language CHECK (language IN ('javascript', 'shell')),
  CONSTRAINT kapi_scripts_handle_format CHECK (handle IS NULL OR handle ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

-- Named (reusable) scripts must be unique per project by handle
CREATE UNIQUE INDEX idx_kapi_scripts_unique_handle
  ON kapi.scripts(project_id, handle)
  WHERE handle IS NOT NULL;

CREATE INDEX idx_kapi_scripts_project ON kapi.scripts(project_id);

CREATE TRIGGER update_kapi_scripts_updated_at
  BEFORE UPDATE ON kapi.scripts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- kapi.requests  (one per saved HTTP call)
-- ---------------------------------------------------------------------------
CREATE TABLE kapi.requests (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  definition_id   UUID NOT NULL REFERENCES kapi.definitions(id) ON DELETE CASCADE,
  folder_id       UUID REFERENCES kapi.request_folders(id) ON DELETE SET NULL,
  name            VARCHAR(200) NOT NULL,
  method          VARCHAR(10) NOT NULL,
  path            TEXT NOT NULL DEFAULT '',
  query_params    JSONB NOT NULL DEFAULT '[]'::jsonb,
  headers         JSONB NOT NULL DEFAULT '[]'::jsonb,
  body_type       VARCHAR(20) NOT NULL DEFAULT 'none',
  body_content    TEXT NOT NULL DEFAULT '',
  body_language   VARCHAR(20) NOT NULL DEFAULT 'text',
  auth_override   JSONB,
  pre_script_id   UUID REFERENCES kapi.scripts(id) ON DELETE SET NULL,
  test_script_id  UUID REFERENCES kapi.scripts(id) ON DELETE SET NULL,
  order_index     INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT kapi_requests_method CHECK (
    method IN ('GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS')
  ),
  CONSTRAINT kapi_requests_body_type CHECK (
    body_type IN ('none','raw','form-data','x-www-form','binary','graphql')
  ),
  CONSTRAINT kapi_requests_body_language CHECK (
    body_language IN ('json','xml','text','graphql','html','yaml')
  )
);

CREATE INDEX idx_kapi_requests_definition ON kapi.requests(definition_id);
CREATE INDEX idx_kapi_requests_def_order ON kapi.requests(definition_id, order_index);
CREATE INDEX idx_kapi_requests_folder ON kapi.requests(folder_id);

CREATE TRIGGER update_kapi_requests_updated_at
  BEFORE UPDATE ON kapi.requests
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- When a request is deleted, drop any inline scripts it uniquely owned.
-- Reusable (is_inline = false) scripts survive independently.
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

-- ---------------------------------------------------------------------------
-- kapi.environments
-- ---------------------------------------------------------------------------
CREATE TABLE kapi.environments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id  UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  handle      VARCHAR(100) NOT NULL,
  name        VARCHAR(200) NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT kapi_environments_handle_format CHECK (handle ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT kapi_environments_unique_handle UNIQUE (project_id, handle)
);

-- Only one active environment per project
CREATE UNIQUE INDEX idx_kapi_environments_one_active
  ON kapi.environments(project_id)
  WHERE is_active = TRUE;

CREATE INDEX idx_kapi_environments_project ON kapi.environments(project_id);

CREATE TRIGGER update_kapi_environments_updated_at
  BEFORE UPDATE ON kapi.environments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- kapi.env_vars
-- ---------------------------------------------------------------------------
CREATE TABLE kapi.env_vars (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  environment_id     UUID NOT NULL REFERENCES kapi.environments(id) ON DELETE CASCADE,
  key                VARCHAR(200) NOT NULL,
  value              TEXT,
  secret_ciphertext  BYTEA,
  is_secret          BOOLEAN NOT NULL DEFAULT FALSE,
  description        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT kapi_env_vars_unique_key UNIQUE (environment_id, key),
  CONSTRAINT kapi_env_vars_secret_shape CHECK (
    (is_secret = TRUE  AND secret_ciphertext IS NOT NULL AND value IS NULL) OR
    (is_secret = FALSE AND secret_ciphertext IS NULL)
  )
);

CREATE INDEX idx_kapi_env_vars_environment ON kapi.env_vars(environment_id);

CREATE TRIGGER update_kapi_env_vars_updated_at
  BEFORE UPDATE ON kapi.env_vars
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- kapi.runs  (append-only execution log)
-- ---------------------------------------------------------------------------
CREATE TABLE kapi.runs (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id        UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  request_id        UUID REFERENCES kapi.requests(id) ON DELETE SET NULL,
  definition_id     UUID REFERENCES kapi.definitions(id) ON DELETE SET NULL,
  environment_id    UUID REFERENCES kapi.environments(id) ON DELETE SET NULL,
  resolved_method   VARCHAR(10) NOT NULL,
  resolved_url      TEXT NOT NULL,
  resolved_headers  JSONB NOT NULL DEFAULT '[]'::jsonb,
  resolved_body     TEXT,
  response_status   INT,
  response_headers  JSONB,
  response_body     TEXT,
  response_time_ms  INT,
  pre_script_log    TEXT,
  test_script_log   TEXT,
  test_results      JSONB,
  error             TEXT,
  executed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kapi_runs_project_executed ON kapi.runs(project_id, executed_at DESC);
CREATE INDEX idx_kapi_runs_request_executed ON kapi.runs(request_id, executed_at DESC);
CREATE INDEX idx_kapi_runs_definition ON kapi.runs(definition_id);
CREATE INDEX idx_kapi_runs_environment ON kapi.runs(environment_id);

-- DOWN

DROP TABLE IF EXISTS kapi.runs;
DROP TABLE IF EXISTS kapi.env_vars;
DROP TABLE IF EXISTS kapi.environments;

DROP TRIGGER IF EXISTS kapi_requests_cleanup_inline_scripts ON kapi.requests;
DROP FUNCTION IF EXISTS kapi.cleanup_inline_scripts();

DROP TABLE IF EXISTS kapi.requests;
DROP TABLE IF EXISTS kapi.scripts;
DROP TABLE IF EXISTS kapi.request_folders;
DROP TABLE IF EXISTS kapi.definitions;

DROP SCHEMA IF EXISTS kapi;
