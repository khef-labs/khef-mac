-- Seed: dbx saved queries
--
-- Source of truth for built-in saved queries shipped with khef. Each query
-- upserts on (connection_id, handle) and replaces its declared params wholesale.
-- Snapshots and run history are NOT touched here — those are user state.
--
-- Pattern per query: a DO block that runs upsert → delete params → insert params
-- sequentially in the same transaction. (A pure CTE chain doesn't work here
-- because data-modifying CTEs share a snapshot — the param INSERT can't see
-- the DELETE, so unique-constraint checks race and 23505.)
--
-- Use dollar-quoted strings ($sql$ ... $sql$) for SQL bodies so embedded
-- single-quotes and :name tokens stay readable.
--
-- All seeded queries bind to the builtin connection (resolved at run time).
-- connection_id is NOT NULL on the table; we look it up via is_builtin = true.

-- ============================================================================
-- memories-by-tag
-- ============================================================================
DO $seed$
DECLARE
  v_id uuid;
  v_conn_id uuid;
BEGIN
  SELECT id INTO v_conn_id FROM dbx.connections WHERE is_builtin = true LIMIT 1;

  INSERT INTO dbx.saved_queries (handle, name, description, sql, schema_scope, is_readonly, is_shared, connection_id)
  VALUES (
    'memories-by-tag',
    'Memories by tag',
    'All memories carrying tag :tag, optionally scoped to a project.',
    $sql$SELECT m.handle, m.title, p.handle AS project, m.updated_at
FROM memories m
JOIN projects p ON p.id = m.project_id
JOIN memory_tags jt ON jt.memory_id = m.id
JOIN tags t ON t.id = jt.tag_id
WHERE t.name = :tag
  AND (:project::text IS NULL OR p.handle = :project)
ORDER BY m.updated_at DESC
LIMIT :limit$sql$,
    'public',
    true,
    true,
    v_conn_id
  )
  ON CONFLICT (connection_id, handle) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    sql = EXCLUDED.sql,
    schema_scope = EXCLUDED.schema_scope,
    is_readonly = EXCLUDED.is_readonly,
    is_shared = EXCLUDED.is_shared,
    owner_session_id = NULL,
    updated_at = NOW()
  RETURNING id INTO v_id;

  DELETE FROM dbx.saved_query_params WHERE query_id = v_id;

  INSERT INTO dbx.saved_query_params (query_id, name, value_type, required, default_value, options, sort_order)
  VALUES
    (v_id, 'tag',     'text',   true,  NULL,  NULL, 0),
    (v_id, 'project', 'text',   false, NULL,  NULL, 1),
    (v_id, 'limit',   'number', false, '25',  NULL, 2);
END $seed$;

-- ============================================================================
-- configs-by-path
-- Find configs by path pattern with their linked assistant. Used to debug
-- assistant discovery — e.g. "did codex-cli's ~/.codex/config.toml get
-- imported and linked correctly?"
-- ============================================================================
DO $seed$
DECLARE
  v_id uuid;
  v_conn_id uuid;
BEGIN
  SELECT id INTO v_conn_id FROM dbx.connections WHERE is_builtin = true LIMIT 1;

  INSERT INTO dbx.saved_queries (handle, name, description, sql, schema_scope, is_readonly, is_shared, connection_id)
  VALUES (
    'configs-by-path',
    'Configs by path',
    'Configs matching a path LIKE pattern, joined to their linked assistant. Use ''%/.codex/%'' or ''%/.claude/%'' to scope to one assistant''s files.',
    $sql$SELECT c.path, c.scope, c.is_import, c.parent_config_id, a.handle AS linked_to
FROM configs c
LEFT JOIN assistant_configs ac ON ac.config_id = c.id
LEFT JOIN assistants a ON a.id = ac.assistant_id
WHERE c.path LIKE :path_pattern
ORDER BY a.handle NULLS FIRST, c.path$sql$,
    'public',
    true,
    true,
    v_conn_id
  )
  ON CONFLICT (connection_id, handle) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    sql = EXCLUDED.sql,
    schema_scope = EXCLUDED.schema_scope,
    is_readonly = EXCLUDED.is_readonly,
    is_shared = EXCLUDED.is_shared,
    owner_session_id = NULL,
    updated_at = NOW()
  RETURNING id INTO v_id;

  DELETE FROM dbx.saved_query_params WHERE query_id = v_id;

  INSERT INTO dbx.saved_query_params (query_id, name, value_type, required, default_value, options, sort_order)
  VALUES
    (v_id, 'path_pattern', 'text', true, NULL, NULL, 0);
END $seed$;

-- ============================================================================
-- assistant-config-counts
-- Per-assistant count of linked global configs with an is_import breakdown.
-- Used to spot discovery gaps (linked=0) vs import filtering bugs (linked>0
-- but imported=0). Optional :assistant filter narrows to a single handle.
-- ============================================================================
DO $seed$
DECLARE
  v_id uuid;
  v_conn_id uuid;
BEGIN
  SELECT id INTO v_conn_id FROM dbx.connections WHERE is_builtin = true LIMIT 1;

  INSERT INTO dbx.saved_queries (handle, name, description, sql, schema_scope, is_readonly, is_shared, connection_id)
  VALUES (
    'assistant-config-counts',
    'Assistant config counts',
    'Per-assistant linked-config counts (global scope), with an is_import breakdown. Optional :assistant handle filter.',
    $sql$SELECT a.handle,
  COUNT(ac.config_id) AS linked_global_configs,
  COUNT(ac.config_id) FILTER (WHERE c.is_import) AS imported_count
FROM assistants a
LEFT JOIN assistant_configs ac ON ac.assistant_id = a.id
LEFT JOIN configs c ON c.id = ac.config_id AND c.scope = 'global'
WHERE (:assistant::text IS NULL OR a.handle = :assistant)
GROUP BY a.handle
ORDER BY a.handle$sql$,
    'public',
    true,
    true,
    v_conn_id
  )
  ON CONFLICT (connection_id, handle) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    sql = EXCLUDED.sql,
    schema_scope = EXCLUDED.schema_scope,
    is_readonly = EXCLUDED.is_readonly,
    is_shared = EXCLUDED.is_shared,
    owner_session_id = NULL,
    updated_at = NOW()
  RETURNING id INTO v_id;

  DELETE FROM dbx.saved_query_params WHERE query_id = v_id;

  INSERT INTO dbx.saved_query_params (query_id, name, value_type, required, default_value, options, sort_order)
  VALUES
    (v_id, 'assistant', 'text', false, NULL, NULL, 0);
END $seed$;
