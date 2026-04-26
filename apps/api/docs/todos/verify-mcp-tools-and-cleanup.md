# TODO: Run integration tests in fresh session for MCP tools (incl. get_memory_by_id) and clean up artifacts

Scope
- Validate all MCP tools end-to-end in a fresh client session against the running khef API
- Explicitly verify get_memory_by_id (UUID-only)
- Ensure no stale state by rebuilding MCP and restarting the session
- Remove any test artifacts created during validation

Checklist
- Rebuild MCP server
  - `npm --prefix mcp-server run build`
- Start a fresh MCP-backed session (new client instance)
  - Ensure the client loads the updated tool schemas
  - Confirm `initialize_session` tool now exposes optional `project_handle`, `project_id`, `project_name`

API sanity checks (direct HTTP)
1) Project UUID
   - `GET /api/projects?handle=khef` → capture UUID
2) Initialize session (GET)
   - `GET /api/initialize_session?project_handle=khef` → expect 200 with session context
   - Also verify permutations (if desired):
     - `GET /api/initialize_session?project_id=<uuid>`
     - `GET /api/initialize_session?project_name=khef`
3) Optional temp project
   - `POST /api/projects` (if needed); record UUID
4) Temp memory (for fetch-by-id)
   - `POST /api/projects/{uuid}/memories` with `{ handle, title, content, type }`
5) Verify global fetch-by-id
   - `GET /api/memories/{memory_uuid}` → expect 200

MCP tool checks
- search_memories
  - `{ project_handle: "khef", q: "<term>", search_mode: "all" }`
- search_content
  - `{ project_handle: "khef", q: "<term>" }`
- search_tags
  - `{ q: "tag-fragment" }`
- create_memory (handle required)
  - `{ project_id: "khef", handle, title, content, type, tags }`
- get_memory_by_id (UUID-only)
  - `{ memory_id: "<uuid>" }` → expect 200
- update_memory / append_memory / delete_memory
  - Update title/content, append content, then delete; confirm each via fetch
- initialize_session (GET)
  - Accepts any of: `project_handle`, `project_id`, `project_name` (all optional; provide at least one)
  - Verify with handle only:
    - `khef - initialize_session (MCP)(project_handle: "khef")`
  - Optionally verify with UUID only and with name only
- get_memory_type_statuses / get_memory_status / update_memory_status
  - Validate status transitions for a memory type
- relations
  - Create relation(s), retrieve graph, then delete relation
- tags
  - list/create/rename/delete

Docs checks (optional)
- `npm run docs:lint`
- `npm run docs:build`

Cleanup
- Delete any temp projects/memories/tags created during tests
- Run a final search to verify no stray resources remain

Notes
- Use `q` instead of `search`
- For path params, project and memory ids are UUID-only
- Prefer `project_handle` for global list filters and for `initialize_session`; use UUID for path routes

Examples (quick)
- MCP: `khef - initialize_session (MCP)(project_handle: "khef")`
- HTTP: `GET /api/initialize_session?project_handle=khef`
