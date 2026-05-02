-- Seed: kapi requests
--
-- Source of truth for built-in kapi requests shipped with khef. Each request
-- is scoped to a (collection_handle, definition_handle, name) tuple so the
-- seed is idempotent: re-running it updates the method/path/headers/body
-- but never duplicates rows. If the parent collection or definition is
-- missing on this database, the request is silently skipped — kapi data is
-- user-owned, so we don't fabricate collections here.
--
-- Pattern per request: a DO block that resolves the definition_id, then
-- upserts the row keyed on (definition_id, name). New requests should follow
-- the same shape so they survive `npm run db:seed:sync` cleanly.

-- ============================================================================
-- Helper: upsert one request keyed on (collection_handle, definition_handle, name).
-- Encapsulated as an inline function-by-DO-block per request below.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Health check
-- ---------------------------------------------------------------------------
DO $seed$
DECLARE
  v_def_id uuid;
  v_req_id uuid;
BEGIN
  SELECT d.id INTO v_def_id
  FROM kapi.definitions d
  JOIN kapi.collections c ON c.id = d.collection_id
  WHERE c.handle = 'khef' AND d.handle = 'khef-local';
  IF v_def_id IS NULL THEN
    RAISE NOTICE 'kapi: skipping "Health check" — definition khef-local in collection khef not found';
    RETURN;
  END IF;
  SELECT id INTO v_req_id FROM kapi.requests
  WHERE definition_id = v_def_id AND name = 'Health check';
  IF v_req_id IS NULL THEN
    INSERT INTO kapi.requests (definition_id, name, method, path)
    VALUES (v_def_id, 'Health check', 'GET', '/health');
  ELSE
    UPDATE kapi.requests SET
      method = 'GET', path = '/health',
      query_params = '[]'::jsonb, headers = '[]'::jsonb,
      body_type = 'none', body_content = '', body_language = 'text',
      updated_at = NOW()
    WHERE id = v_req_id;
  END IF;
END $seed$;

-- ---------------------------------------------------------------------------
-- List assistants (debug codex visibility)
-- ---------------------------------------------------------------------------
DO $seed$
DECLARE
  v_def_id uuid;
  v_req_id uuid;
BEGIN
  SELECT d.id INTO v_def_id
  FROM kapi.definitions d
  JOIN kapi.collections c ON c.id = d.collection_id
  WHERE c.handle = 'khef' AND d.handle = 'khef-local';
  IF v_def_id IS NULL THEN
    RAISE NOTICE 'kapi: skipping "List assistants" — definition khef-local in collection khef not found';
    RETURN;
  END IF;
  SELECT id INTO v_req_id FROM kapi.requests
  WHERE definition_id = v_def_id AND name = 'List assistants (debug codex visibility)';
  IF v_req_id IS NULL THEN
    INSERT INTO kapi.requests (definition_id, name, method, path)
    VALUES (v_def_id, 'List assistants (debug codex visibility)', 'GET', '/api/assistants');
  ELSE
    UPDATE kapi.requests SET
      method = 'GET', path = '/api/assistants',
      query_params = '[]'::jsonb, headers = '[]'::jsonb,
      body_type = 'none', body_content = '', body_language = 'text',
      updated_at = NOW()
    WHERE id = v_req_id;
  END IF;
END $seed$;

-- ---------------------------------------------------------------------------
-- Get codex-cli assistant
-- ---------------------------------------------------------------------------
DO $seed$
DECLARE
  v_def_id uuid;
  v_req_id uuid;
BEGIN
  SELECT d.id INTO v_def_id
  FROM kapi.definitions d
  JOIN kapi.collections c ON c.id = d.collection_id
  WHERE c.handle = 'khef' AND d.handle = 'khef-local';
  IF v_def_id IS NULL THEN
    RAISE NOTICE 'kapi: skipping "Get assistant codex-cli" — definition khef-local in collection khef not found';
    RETURN;
  END IF;
  SELECT id INTO v_req_id FROM kapi.requests
  WHERE definition_id = v_def_id AND name = 'Get assistant codex-cli';
  IF v_req_id IS NULL THEN
    INSERT INTO kapi.requests (definition_id, name, method, path)
    VALUES (v_def_id, 'Get assistant codex-cli', 'GET', '/api/assistants/codex-cli');
  ELSE
    UPDATE kapi.requests SET
      method = 'GET', path = '/api/assistants/codex-cli',
      query_params = '[]'::jsonb, headers = '[]'::jsonb,
      body_type = 'none', body_content = '', body_language = 'text',
      updated_at = NOW()
    WHERE id = v_req_id;
  END IF;
END $seed$;

-- ---------------------------------------------------------------------------
-- List global configs for codex-cli
-- ---------------------------------------------------------------------------
DO $seed$
DECLARE
  v_def_id uuid;
  v_req_id uuid;
BEGIN
  SELECT d.id INTO v_def_id
  FROM kapi.definitions d
  JOIN kapi.collections c ON c.id = d.collection_id
  WHERE c.handle = 'khef' AND d.handle = 'khef-local';
  IF v_def_id IS NULL THEN
    RAISE NOTICE 'kapi: skipping "List global configs (codex-cli)" — definition khef-local in collection khef not found';
    RETURN;
  END IF;
  SELECT id INTO v_req_id FROM kapi.requests
  WHERE definition_id = v_def_id AND name = 'List global configs (codex-cli)';
  IF v_req_id IS NULL THEN
    INSERT INTO kapi.requests (definition_id, name, method, path, query_params)
    VALUES (
      v_def_id,
      'List global configs (codex-cli)',
      'GET',
      '/api/assistants/codex-cli/configs',
      '[{"key":"scope","value":"global","enabled":true}]'::jsonb
    );
  ELSE
    UPDATE kapi.requests SET
      method = 'GET',
      path = '/api/assistants/codex-cli/configs',
      query_params = '[{"key":"scope","value":"global","enabled":true}]'::jsonb,
      headers = '[]'::jsonb,
      body_type = 'none', body_content = '', body_language = 'text',
      updated_at = NOW()
    WHERE id = v_req_id;
  END IF;
END $seed$;

-- ---------------------------------------------------------------------------
-- List global configs for claude-code (comparison baseline)
-- ---------------------------------------------------------------------------
DO $seed$
DECLARE
  v_def_id uuid;
  v_req_id uuid;
BEGIN
  SELECT d.id INTO v_def_id
  FROM kapi.definitions d
  JOIN kapi.collections c ON c.id = d.collection_id
  WHERE c.handle = 'khef' AND d.handle = 'khef-local';
  IF v_def_id IS NULL THEN
    RAISE NOTICE 'kapi: skipping "List global configs (claude-code)" — definition khef-local in collection khef not found';
    RETURN;
  END IF;
  SELECT id INTO v_req_id FROM kapi.requests
  WHERE definition_id = v_def_id AND name = 'List global configs (claude-code)';
  IF v_req_id IS NULL THEN
    INSERT INTO kapi.requests (definition_id, name, method, path, query_params)
    VALUES (
      v_def_id,
      'List global configs (claude-code)',
      'GET',
      '/api/assistants/claude-code/configs',
      '[{"key":"scope","value":"global","enabled":true}]'::jsonb
    );
  ELSE
    UPDATE kapi.requests SET
      method = 'GET',
      path = '/api/assistants/claude-code/configs',
      query_params = '[{"key":"scope","value":"global","enabled":true}]'::jsonb,
      headers = '[]'::jsonb,
      body_type = 'none', body_content = '', body_language = 'text',
      updated_at = NOW()
    WHERE id = v_req_id;
  END IF;
END $seed$;

-- ---------------------------------------------------------------------------
-- List projects (cross-check DB connectivity)
-- ---------------------------------------------------------------------------
DO $seed$
DECLARE
  v_def_id uuid;
  v_req_id uuid;
BEGIN
  SELECT d.id INTO v_def_id
  FROM kapi.definitions d
  JOIN kapi.collections c ON c.id = d.collection_id
  WHERE c.handle = 'khef' AND d.handle = 'khef-local';
  IF v_def_id IS NULL THEN
    RAISE NOTICE 'kapi: skipping "List projects (debug)" — definition khef-local in collection khef not found';
    RETURN;
  END IF;
  SELECT id INTO v_req_id FROM kapi.requests
  WHERE definition_id = v_def_id AND name = 'List projects (debug)';
  IF v_req_id IS NULL THEN
    INSERT INTO kapi.requests (definition_id, name, method, path)
    VALUES (v_def_id, 'List projects (debug)', 'GET', '/api/projects');
  ELSE
    UPDATE kapi.requests SET
      method = 'GET', path = '/api/projects',
      query_params = '[]'::jsonb, headers = '[]'::jsonb,
      body_type = 'none', body_content = '', body_language = 'text',
      updated_at = NOW()
    WHERE id = v_req_id;
  END IF;
END $seed$;
