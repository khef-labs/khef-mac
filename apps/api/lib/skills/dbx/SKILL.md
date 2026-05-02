---
name: dbx
description: This skill should be used when the user asks to "save this query", "create a saved query", "make a dbx query", "add a saved query for {topic}", "snapshot this saved query", "restore a saved query", or wants to author/run/manage parameterized SQL the agent can re-run later. Also triggers on bare "dbx", "saved query", "saved-query", "saved queries panel", "param sampler", and on requests to add `:name` parameters to a query stored in khef.
---

# Dbx — Database Explorer & Saved Queries

`dbx` is khef's built-in database explorer. The piece this skill covers is **saved queries**: parameterized SQL snippets stored in the `dbx.*` Postgres schema, runnable through the UI or via MCP. They are the agent's primary way to give the user reusable SQL with typed inputs.

Connections, scripts, schema browsing, and ERD generation are also part of dbx but rarely need scripted authoring — see `ctx-dbx-database-explorer` for the broader picture.

## Resource model

```
dbx.connections           ── saved connection (host/port/db + encrypted creds)
                                 ▲ (nullable FK)
dbx.saved_queries  ──┬── saved_query_params  (declared :name params)
                     ├── saved_query_favorites (per-session star)
                     └── saved_query_snapshots (manual + pre-restore)
                          ▲ (current_snapshot pointer on saved_queries)
dbx.query_history        ── append-only run log (linked to saved_queries via query_id)
dbx.scripts              ── unparameterized SQL scratchpads (separate from saved queries)
```

A saved query has:

- `connection_id` (nullable) — optional FK; null means "any connection". The UI runs null-bound queries against the builtin khef connection.
- `handle` (kebab-case, unique per connection) — the stable identifier.
- `sql` — the live SQL. Editing is free; snapshots are explicit point-in-time captures.
- `params[]` — declared parameters (each has `name`, `value_type`, `required`, `default_value`, `options`).
- `is_readonly` (default true) — when true, runs wrap in `BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout=10000; …; COMMIT`. Any DML errors with `cannot execute … in a read-only transaction`.
- `is_shared` (default false) — visible across sessions when true.
- `current_snapshot` — pointer to the snapshot whose SQL matches the live row right now. Set on capture/restore.

## Parameter syntax

In the SQL body, reference a parameter as `:name`. The server runs it through `bindNamedParams()` which:

- Skips `:name` tokens inside string literals (`'…'`), double-quoted identifiers (`"…"`), dollar-quoted strings (`$tag$ … $tag$`), line comments (`-- …`), block comments (`/* … */`, nesting OK), and the `::` cast operator.
- Validates declared vs supplied params (rejects undeclared tokens and unknown supplied keys).
- Coerces values per `value_type`: `text` → string, `number` → finite Number, `bool` → `true`/`false` (accepts `'true'`/`'false'`/`1`/`0`), `enum` → string in `options[]`.
- Rewrites `:name` → `$N`, reusing the same `$N` for repeated tokens.

## Postgres NULL casting gotcha

Postgres can't infer a type for `$N IS NULL` when the param is otherwise unused — you'll get `could not determine data type of parameter $N`. Always cast NULL-checks:

```sql
-- ❌ Fails when :project is null
WHERE (:project IS NULL OR p.handle = :project)

-- ✅ Works
WHERE (:project::text IS NULL OR p.handle = :project)
```

Same pattern for any optional filter: `(:foo::int IS NULL OR table.col = :foo)`.

## Canonical workflow — author a saved query

For "save this query so I can re-run it later":

1. **Pick a project handle** (informational — saved queries aren't project-scoped, but `connection_id: null` means "use the builtin khef DB").

2. **Write the SQL with `:name` tokens** for any value the caller should supply at run time. Make optional filters NULL-safe with `::type` casts.

3. **Declare every `:name` in `params[]`**. Required params have no `default_value`; optional ones should set one so the form pre-fills.

   ```
   create_saved_query(
     name: "Memories by tag",
     handle: "memories-by-tag",
     description: "All memories carrying tag :tag, optionally scoped to a project.",
     schema_scope: "public",
     sql: "SELECT m.handle, m.title, p.handle AS project, m.updated_at\n" +
          "FROM memories m\n" +
          "JOIN projects p ON p.id = m.project_id\n" +
          "JOIN memory_tags jt ON jt.memory_id = m.id\n" +
          "JOIN tags t ON t.id = jt.tag_id\n" +
          "WHERE t.name = :tag\n" +
          "  AND (:project::text IS NULL OR p.handle = :project)\n" +
          "ORDER BY m.updated_at DESC\n" +
          "LIMIT :limit;",
     params: [
       { name: "tag",     value_type: "text",   required: true,  sort_order: 0 },
       { name: "project", value_type: "text",   required: false, sort_order: 1 },
       { name: "limit",   value_type: "number", required: false, default_value: "25", sort_order: 2 }
     ],
     owner_session_id: "<your nickname or session id>"
   )
   ```

4. **Smoke test it** with `run_saved_query` immediately after creation. The error message names the field (`{ error: "...", field: "..." }`) so you can fix declarations or the SQL.

5. **Share the link** so the user can open it in `/database`:
   `http://localhost:5174/memories/<saved-query-id>` does NOT work — saved queries aren't memories. Direct the user to the **SAVED QUERIES** sidebar in the database tab.

## Param value types

| Type | Form widget | Coercion |
|------|-------------|----------|
| `text` | text input | `String(value)` |
| `number` | number input | `Number(value)`; rejects non-finite |
| `bool` | toggle / select | `'true'`, `'false'`, `1`, `0`, real booleans |
| `enum` | select | must be in declared `options[]` |

`required: true` means runtime omission errors with `Missing required parameter :name`. Empty string also counts as missing. Optional params with `default_value` fall back to that string (run through coercion).

## Run flow

```
run_saved_query(
  id: "<uuid>",
  params: { tag: "feature", project: null, limit: 10 },
  session_id: "<session id or nickname for traceability>"
)
```

Server:
1. Loads declared params, runs `bindNamedParams(sql, declared, params)`.
2. Resolves the connection: explicit `connection_id` else builtin khef.
3. Calls `driver.executeQuery(boundSql, { params, readOnly: is_readonly, maxRows, timeout })`.
4. On success: returns `{ columns, rows, rowCount, duration, queryId, truncated }` and logs to `dbx.query_history` with `query_id`, `session_id`, `params_snapshot`, `status: 'success'`.
5. On failure: returns 400 with `{ error, duration, queryId }` and logs `status: 'error'`.

The UI's `Run` button (and `⌘Enter`) auto-saves any unsaved SQL edits before invoking `/run`.

## Snapshot lifecycle

Snapshots mirror memory snapshots: editing the SQL is free, **explicit** snapshots are point-in-time captures.

- **Capture (`create_saved_query_snapshot`)**: serialises current `sql` + declared params to `dbx.saved_query_snapshots`, bumps `saved_queries.current_snapshot` to the new number. Source: `'manual'`.
- **Restore (`restore_saved_query_snapshot`)**: captures a `'pre-restore'` safety snapshot of the current state first, then overwrites the live SQL + params from the chosen snapshot, sets `current_snapshot` to that snapshot's number.
- **Delete-current is rejected** with HTTP 409 (parity with memory snapshots' "current cannot be deleted" rule). Capture a new snapshot first, or restore a different one to move the pointer.
- The UI dropdown shows snapshots newest-first with `#N current` selected for `current_snapshot`. Picking another snapshot enters **read-only view mode** in the editor; the banner exposes a `Restore` button.

There is no hard cap on snapshots — historical snapshots stay until the user deletes them via the manage modal.

## MCP tool inventory

CRUD:

| Tool | Purpose |
|------|---------|
| `list_saved_queries` | Filter by connection / favorite / shared / fuzzy match. Use `session_id` to resolve favorites. |
| `get_saved_query` | Full SQL, params, `current_snapshot`, `is_favorite`. |
| `create_saved_query` | New saved query with optional declared `params[]`. |
| `update_saved_query` | PATCH. `params` replaces all rows when supplied. No auto-snapshot — call `create_saved_query_snapshot` separately if you want one. |
| `delete_saved_query` | Cascades to params, favorites, snapshots. Run-history rows have `query_id` nulled but stay. |

Run + history:

| Tool | Purpose |
|------|---------|
| `run_saved_query` | Bind params and execute. Read-only by default. Logs to `dbx.query_history`. |

Snapshots:

| Tool | Purpose |
|------|---------|
| `list_saved_query_snapshots` | Newest-first list. |
| `create_saved_query_snapshot` | Capture current state, advance `current_snapshot`. |
| `restore_saved_query_snapshot` | Pre-restore safety + content swap + pointer update. |
| `delete_saved_query_snapshot` | Permanent delete. Rejects current. |

## Common pitfalls

- **`could not determine data type of parameter $N`** — missing `::type` cast on a NULL-checked optional param. See gotcha above.
- **`SQL references undeclared parameter :foo`** — the SQL has `:foo` but no matching entry in `params[]`. Declare it.
- **`Unknown parameter "bar" supplied at run time`** — caller passed a key not declared. Drop the extra key or declare the param.
- **`A saved query with that handle already exists for this connection`** (HTTP 409) — handle is unique within a connection (with NULL connections in their own bucket). Pick a different handle or update the existing one.
- **`handle must be kebab-case`** (HTTP 400) — `^[a-z0-9]+(?:-[a-z0-9]+)*$`. Lowercase letters, digits, hyphens; can't start or end with a hyphen.
- **`cannot execute DELETE in a read-only transaction`** — DML in a saved query needs `is_readonly: false` (rare; only when the user explicitly wants a writing query).
- **Legacy column names** — `memory_type_statuses.status_value` (not `value`). `memories.status_id` (not `status`). Use `mcp__khef__describe_table` if unsure.

## Where things live

| File | Role |
|------|------|
| `apps/api/db/migrate/migrations/20260429141557_create_dbx_saved_queries.sql` | Tables: `saved_queries`, `saved_query_params`, `saved_query_favorites`, `saved_query_versions` (renamed below) |
| `apps/api/db/migrate/migrations/20260430081659_rename_saved_query_versions_to_snapshots.sql` | Rename to `saved_query_snapshots` + add `source` column |
| `apps/api/db/migrate/migrations/20260430095943_add_current_snapshot_to_dbx_saved_queries.sql` | `current_snapshot` pointer column |
| `apps/api/src/routes/dbx.ts` | All `/api/dbx/*` routes |
| `apps/api/src/services/dbx/sql-params.ts` | `bindNamedParams()` + `ParamBindError` |
| `apps/api/src/services/dbx/drivers/postgres.ts` | `executeQuery(sql, { params, readOnly, … })` with read-only transaction wrapping |
| `apps/api/mcp-server/src/tools/saved-queries.ts` | All saved-query MCP tools |
| `apps/ui/src/pages/database-page/DatabasePage.tsx` | Toolbar (snapshot dropdown + camera + Save), view-mode banner, run wiring |
| `apps/ui/src/pages/database-page/SavedQueriesPanel.tsx` | Sidebar (Favorites / Recent / All) |
| `apps/ui/src/pages/database-page/ParametersForm.tsx` | Per-tab params form |
| `apps/ui/src/pages/database-page/SnapshotsModal.tsx` | Bulk-delete management modal |

## Tips

- When the user says **"save this query"** or pastes raw SQL: declare every `:name` you can find, then smoke-test with `run_saved_query` so you know it actually binds.
- When the user says **"snapshot this"**: `create_saved_query_snapshot` — no need to involve the modal.
- When the user says **"restore #N"** or **"go back to the previous version"**: `restore_saved_query_snapshot` — they don't need to leave the chat.
- When debugging a failed run, fetch the run row from `dbx.query_history` to see the bound params and the exact SQL that was sent.
