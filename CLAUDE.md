# Khef

Project memory API with PostgreSQL backend for tracking development decisions, context, and knowledge across projects.

## Development

Run the API and UI in separate terminals:

```bash
npm run dev:api   # API on port 3201
npm run dev:ui    # UI on port 5174
```

First-time setup: `npm run setup`
After pulling changes: `npm run refresh`

## Architecture

- **Framework**: Fastify (TypeScript)
- **Database**: PostgreSQL 17 with pgvector extension
- **Vector Search**: kvec/pgvector, local embeddings via sentence-transformers
- **Diagram Rendering**: Kroki (mermaid, d2, plantuml, graphviz)
- **Key Features**: Memory CRUD, tagging, relations graph, polymorphic status system, auto-chunking (>2000 chars), semantic search

## Database Schema

- `projects` - Project containers
- `memory_types` - Memory type definitions (user-note, user-todo, decision, etc.)
- `memory_type_statuses` - Type-specific status values (polymorphic status system)
- `memories` - Core memory storage with type and status foreign keys
- `memory_chunks` - Auto-chunked content for large memories
- `memory_embeddings` - Vector embeddings stored via pgvector (768-dim)
- `vector_delete_queue` - Queue for tracking deleted memory IDs for vector sync
- `tags` - Tag definitions
- `memory_tags` - Many-to-many memory-tag relations
- `relation_types` - Relation type definitions with forward/inverse labels
- `memory_relations` - Directed graph edges (relates_to, contradicts, supports, depends_on, follows_from, references, supersedes, implements, blocks, extends, duplicates)
- `diffs` - Git diff metadata for attaching comments to commits
- `config_snapshots` - Config content history with sequential snapshot numbers
- `prompts` - Reusable prompt templates with versioning
- `sessions` - Parsed session transcripts from Claude Code and Codex CLI
- `session_chunks` - Auto-chunked session content for full-text search
- Kdag tables in `kdag` schema: `job_definitions`, `job_definition_steps`, `job_definition_inputs`, `input_types`, `jobs`, `job_runs`, `job_steps`, `job_inputs`, `job_outputs`

Full endpoint list available via `get_project_knowledge(project_handle: "khef")` or by reading route files in `apps/api/src/routes/`.

## OpenAPI Spec

Multi-file OpenAPI 3.0 spec under `apps/api/docs/api/`:

```
docs/api/
  openapi.yaml              # Root — info, servers, tags, $ref pointers
  paths/                    # 25 resource files (memories.yaml, projects.yaml, etc.)
  components/
    schemas.yaml            # All schemas
    parameters.yaml         # Shared path/query parameters
    responses.yaml          # Reusable error responses
```

**Commands:** `npm run docs:lint`, `npm run docs:bundle`, `npm run docs:preview`

## Tag Format

All memory-returning endpoints return tags as objects: `[{ "id": "uuid", "name": "tag-name" }]`

## Settings

App-wide configuration stored in the `settings` table (key-value pairs).

Key settings: `layout.pageWidth`, `diagram.defaultMaxWidth`, `export.imageTheme`, `drive.syncFolder`, `vector.enabled`, `gemini.project`, `gemini.location`, `gemini.defaultModel`

## Memory Types

**Notes:** `user-note`, `assistant-note`, `project-note`
**Todos:** `user-todo`, `assistant-todo`
**Knowledge:** `knowledge` (parent type grouping `commands`, `context`, `pattern`)
**Canvas:** `canvas` (parent type grouping `widget`, `animation`, `prototype`, `quiz`) — interactive HTML/JS/CSS content rendered in sandboxed iframes
**Others:** `decision`, `command`, `api`, `reference`, `assistant-rule`, `diagram`, `csv`, `video`

## Seeds

Memories are seeded from markdown files in `db/seed/memories/<project>/` (YAML frontmatter + markdown body). Kdag definitions from `db/seed/definitions/`. Both are idempotent upserts.

Key commands: `npm run db:seed:sync` (preferred — seeds and syncs rules/knowledge to disk), `npm run db:seed` (seed only), `npm run memory:export`

## Glossary Config

User-editable glossary files synced as `glossary` type configs:

- **User-level**: `~/.claude/KF-GLOSSARY.md` — auto-created with template on first sync, imported via `@~/.claude/KF-GLOSSARY.md` in `CLAUDE.md`
- **Project-level**: `{project}/KF-GLOSSARY.md` — opt-in, manually created; if present, imported via `@./KF-GLOSSARY.md` in `CLAUDE.local.md`

Glossary sync runs as part of `npm run db:seed:sync` and the `seed_and_sync` MCP tool. Endpoint: `POST /api/projects/:projectId/knowledge/glossary/sync`.

## Reserved "user" Project

Handle `user` exists for general memories not tied to a specific project. Created via migration, cannot be deleted.

## MCP Server

The MCP server (`mcp-server/`) provides 140+ tools for memory management and pipeline orchestration. Use `/mcp` to see the full tool list.

**Key workflow tools:**
- `initialize_session` - Start session, loads project context
- `unified_search` - **Search all backends in one call** (memories, source code, commits, sessions, docs, slack). Use this first for any search task.
- `search_memories` - Full-text or semantic search with filters (use for targeted memory queries with type/tag/status filters)
- `create_memory` / `update_memory` / `get_memory_by_id` - Memory CRUD
- `create_memory_from_file` / `update_memory_from_file` - File-based memory create/update (read content from disk)
- `update_memory_status` - Change memory status
- `create_relation` / `get_memory_graph` - Knowledge graph
- `get_project_knowledge` - Load operational knowledge
- `set_project_commands` / `set_project_context` / `set_project_pattern` - Update knowledge
- `search_sessions` - Search past session transcripts (use for targeted session queries with session_id filter)
- `grep_sessions` - Raw ripgrep over session JSONL files on disk. Searches the full transcript (including tool_result blocks that `search_sessions` strips at index time). Use for exact strings like Jira account IDs, error messages, or UUIDs that don't surface via the indexed search. Requires a scope: session_id, nickname, or project_dir.
- `search_source_code` / `search_commits` - Vector search over code and commits (use for targeted queries with language/repo filters)
- `view_source_code_file` - Read a file by kvec-indexed `repo`+`path`, or by absolute `abs_path` (must resolve inside $HOME; `~` expanded). Optional start/end line slice and git ref (uses `git show` without touching the working tree)
- `search_docs` / `get_doc_content` - Semantic search and paginated content retrieval for indexed documents (markdown, PDF, text)
- `query_khef` / `query_kvec` / `query_kdag` - Direct read-only SQL
- `export_kdag_job` - Export all job inputs/outputs to disk
- `export_job_definition` - Export a definition + its prompts and code scripts as seed-compatible files
- `get_session_lineage_token_count` - Estimate the token cost of rehydrating a session lineage by nickname (no file writes)
- `read_trace_log` - Read and format khef log files (trace, api-errors, api, workers, ui, debug) with filtering

Tip: If you already know the project handle, call tools directly with it (no need for `get_project` first).

### Troubleshooting MCP

If MCP tools fail with `fetch failed` or show no tools:
- Verify API health: `curl -s http://localhost:3201/health`
- Confirm `~/.claude.json` → `mcpServers.khef` points to correct build output and port
- Rebuild: `npm run mcp:build`
- Restart Claude Code so MCP server reinitializes

### Agent Workflow

When starting work on this project:

1. **Initialize session**: `initialize_session(project_id: "khef")` — returns project info, rules, todos, recent context
2. **Work on tasks**: Document decisions, patterns, and context as you work
3. **Link knowledge**: Use `create_relation` to connect related memories
4. **Search as needed**: `unified_search` for broad discovery across all backends, or `search_memories` for targeted queries with type/tag/status filters

### Memory Creation Guidelines

- **Titles**: Descriptive, max 200 chars, unique within project
- Use `decision` for architectural choices, `pattern` for recurring conventions, `context` for background info, `assistant-rule` for behavioral guidelines
- Always add relevant tags for discoverability

### Building the Knowledge Graph

Link related memories using `create_relation(source, target, type)`:

| Relation | Direction (Source - Target) | Example |
|----------|----------------------------|---------|
| `supports` | Evidence - Claim | pattern `supports` decision |
| `contradicts` | Newer - Older | new decision `contradicts` old |
| `depends_on` | Dependent - Dependency | decision `depends_on` context |
| `follows_from` | Effect - Cause | pattern `follows_from` decision |
| `references` | Referrer - Referenced | context `references` reference |
| `supersedes` | Newer - Older | new decision `supersedes` old |
| `implements` | Implementation - Spec | pattern `implements` decision |
| `blocks` | Blocker - Blocked | task `blocks` another task |
| `extends` | Extension - Base | feature `extends` existing |
| `duplicates` | Duplicate - Original | memory `duplicates` another |
| `relates_to` | Either (last resort) | todo `relates_to` decision |

## Testing

Integration tests against real PostgreSQL (Vitest, sequential, single-threaded). Test DB on port 5433 (ephemeral tmpfs).

Key commands: `npm run test:db:up`, `npm run test`, `npm run test:integration`

Coverage: Memory CRUD, relations, projects, cross-project search, status system, auto-chunking, configs, comments, sessions, diffs, assistant memory files.
