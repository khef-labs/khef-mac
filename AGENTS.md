# Agent Guidance for khef

This document provides guidance for AI agents working with the khef project memory system.

## Philosophy

khef is designed to help AI agents build and maintain a knowledge graph of project decisions, patterns, context, and guidelines. Think of it as a persistent memory system that grows smarter over time.

## Core Concepts

### Memory Types

Each memory has a specific type that defines its purpose:

**Notes:**
- **`user-note`** - Notes created by users
- **`assistant-note`** - Notes created by AI assistants
- **`project-note`** - General project information

**Todos:**
- **`user-todo`** - Tasks created by users
- **`assistant-todo`** - Tasks for AI assistants to work on

**Knowledge** (`knowledge` parent type — groups operational project knowledge):
- **`commands`** - Common commands and scripts for a project
- **`context`** - Background information explaining why things are the way they are
- **`pattern`** - Recurring code patterns, conventions, and best practices

**Others:**
- **`decision`** - Architectural decisions, technical choices, and their rationale
- **`command`** - Single command memory (legacy; prefer `commands` for project-level)
- **`api`** - API documentation, endpoint descriptions, and usage examples
- **`reference`** - External references, links, and documentation pointers
- **`assistant-rule`** - Behavioral guidelines, coding standards, commit rules, etc.
- **`diagram`** - Diagrams rendered via Kroki (mermaid, d2, plantuml, graphviz)

### Relations

Memories can be linked with typed relations to create a knowledge graph. The **source** is the memory you're linking FROM, the **target** is what it links TO.

| Relation | Use When | Direction (Source → Target) |
|----------|----------|----------------------------|
| `supports` | Evidence backs up a claim | Evidence → Claim |
| `contradicts` | Information conflicts | Newer → Older (supersedes) |
| `depends_on` | Can't exist without the other | Dependent → Dependency |
| `follows_from` | Caused by or derived from | Effect → Cause |
| `references` | Mentions or cites | Referrer → Referenced |
| `relates_to` | Loosely connected (last resort) | Either direction |

**Common Patterns:**
- Decision supersedes decision: new `contradicts` old
- Pattern supports decision: pattern `supports` decision
- Context explains decision: context `supports` decision
- Decision depends on context: decision `depends_on` context
- Implementation follows decision: pattern `follows_from` decision
- Todo tracks decision: todo `relates_to` decision

**When NOT to Create Relations:**
- Don't force it - if unsure, memories might not be related
- Don't create circular chains (A→B→C→A)
- Don't duplicate - one relation per pair is enough
- Don't over-link - 2-4 relations per memory is typical

### Tags

Tags enable flexible organization and filtering. Use tags to categorize by:
- Technology/framework (e.g., "fastify", "postgresql", "typescript")
- Domain area (e.g., "auth", "database", "api")
- Functionality (e.g., "migrations", "testing", "validation")

## Recommended Agent Workflow

### 1. Session Initialization

At the start of each session:

```
1. get_project(name: "<project-name>")
   → Retrieve project_id for all subsequent operations

2. get_agent_rules(project_id: "<project-id>")
   → Load project-specific behavioral guidelines
   → Learn commit message formats, coding standards, etc.

3. search_memories(project_id: "<project-id>", type: "context")
   → Understand project background and current state
```

### 2. Working on Tasks

When implementing features or solving problems:

```
1. Search for relevant context
   → search_memories(search: "authentication", type: "decision")
   → Review existing decisions before making new ones

2. Search for patterns
   → search_memories(search: "error handling", type: "pattern")
   → Follow established conventions

3. Document decisions as you work
   → create_memory(content: "Decision rationale...", type: "decision")
   → Include the "why" not just the "what"

4. Link related knowledge
   → create_relation(source: "new-decision", target: "supporting-pattern")
   → Build connections for future context retrieval
```

### 3. Knowledge Graph Building

Build a rich knowledge graph by:

```
1. Creating memories for significant decisions
2. Linking decisions to supporting patterns
3. Connecting patterns to API documentation
4. Marking contradictions when approaches change
5. Using depends_on for dependency chains
```

### 4. Memory Maintenance

Keep the memory system healthy:

```
1. Use update_memory to refine content
2. Use update_memory_status to change memory status (e.g., mark todos as done)
3. Use get_memory_type_statuses to discover valid status values for each type
4. Create new memories that reference outdated ones
5. Use contradicts relation to mark superseded decisions
```

## Best Practices

### When to Create Memories

**DO create memories for:**
- ✓ Architectural decisions and their rationale
- ✓ Significant technical choices (framework, library, pattern)
- ✓ Non-obvious patterns and conventions
- ✓ Important context that explains "why"
- ✓ Project-specific agent rules and standards

**DON'T create memories for:**
- ✗ Obvious or self-explanatory code
- ✗ Temporary implementation details
- ✗ Information already in documentation
- ✗ Trivial changes or routine updates

### Writing Effective Memory Content

1. **Be concise but complete** - Include rationale, not just facts
2. **Focus on "why"** - Decisions without reasoning lose value
3. **Include context** - What problem does this solve?
4. **Use clear language** - Future agents should understand immediately
5. **Add relevant tags** - Enable easy discovery

### Example: Good Decision Memory

```
Type: decision
Content: "Use Fastify framework for the API server due to its performance,
TypeScript support, and rich plugin ecosystem. Chosen over Express for better
async/await handling, lower overhead, and superior schema validation with
JSON Schema support."
Tags: ["architecture", "fastify", "backend"]
```

### Example: Good Pattern Memory

```
Type: pattern
Content: "Database migrations pattern: Use timestamp-prefixed SQL files in
migrations/ directory. Each migration should be idempotent and include both
up and down operations. Run via npm scripts that execute migrations in order."
Tags: ["database", "migrations", "postgresql"]
```

### Building Relations

Create relations to build a knowledge graph:

```
Decision: "Use Fastify"
  ↓ relates_to
Pattern: "Database migrations pattern"
  ↓ references
Agent-rule: "Commit message guidelines"
```

This creates a traversable graph where agents can:
- Start at a decision
- Find related patterns
- Discover relevant guidelines
- Understand the full context

### Using Graph Traversal

```
get_memory_graph(memory_id: "fastify-decision", depth: 2)
```

Returns nodes and edges for visualization and context gathering. Use this to:
- Understand decision dependencies
- Find all related context before making changes
- Verify consistency across decisions

## Integration Patterns

### For Claude Code (via MCP Server)

Use the MCP tools directly in Claude Code sessions. The server provides tools as native Claude Code capabilities:

**Project:** list_projects, create_project, get_project, initialize_session

Note: If you already know the project handle, prefer calling tools directly with the handle (and use initialize_session for startup). Use get_project only for discovery/validation or when a tool explicitly requires a UUID.

**Memory:** search_memories (content+tags), search_content, search_tags, create_memory, update_memory, append_memory, delete_memory, get_memory_by_id

Search tools return **compact results by default** (content_excerpt ~240 chars). Use `get_memory_by_id` for full content.
**Status:** get_memory_type_statuses, get_memory_status, update_memory_status
**Relations:** create_relation, get_memory_graph
**Tags:** list_tags, get_tag_memories, create_tag, rename_tag, delete_tag
**Agent Rules:** get_agent_rules
**Graph Health:** get_graph_health

**Cross-project search:** Use `search_memories` without `project_id` to search across all projects:
```
search_memories(search: "authentication", type: "decision")
→ Returns decisions about authentication from ALL projects
```

### Troubleshooting MCP (Codex CLI)

If MCP tools fail with `fetch failed` or return no tools/resources:
- Verify khef API health: `curl -s http://localhost:3100/health`
- Confirm Codex MCP config points to the right port and build output:
  - `~/.codex/config.toml` → `[mcp_servers.khef]` uses `mcp-server/build/index.js`
  - `~/.codex/config.toml` → `KHEF_API_URL = "http://localhost:3100"`
- To add the server from the CLI instead of editing TOML manually:
  ```bash
  codex mcp add khef \
    --env KHEF_API_URL=http://localhost:3100 \
    -- node "/absolute/path/to/khef/mcp-server/build/index.js"
  ```
- A minimal `~/.codex/config.toml` entry looks like:
  ```toml
  [mcp_servers.khef]
  command = "node"
  args = ["/absolute/path/to/khef/mcp-server/build/index.js"]
  startup_timeout_sec = 15
  tool_timeout_sec = 60

  [mcp_servers.khef.env]
  KHEF_API_URL = "http://localhost:3100"
  ```
- In Codex, `/mcp` should show a connected `khef` server and its tool list
- Rebuild the MCP server after changes: `npm --prefix mcp-server run build`
- Restart the Codex session to reload MCP config and schemas
- Ensure the MCP server is registered and visible in Codex (e.g., `/mcp` if available)
- Ensure docker khef database container is up and running `docker ps | grep khef`

### For Other Agents

Use the REST API directly:
- `GET /api/projects` - List projects (case-insensitive name lookup)
- `GET /api/projects/:projectId/memories` - Query memories with filters (project-scoped)
- `GET /api/memories` - **Cross-project search** with optional `project_id` filter
- `POST /api/projects/:projectId/memories` - Create memories
- `POST /api/projects/:projectId/memories/:id/append` - Append content to memory
- `DELETE /api/projects/:projectId/memories/:id` - Delete a memory
- `PUT /api/projects/:projectId/memories/:id/status` - Update memory status
- `GET /api/memory-types/:type/statuses` - Get valid status values
- `POST /api/relations` - Create relations
- `GET /api/relations/memory/:id/graph?depth=N` - Graph traversal
- `GET /api/projects/:projectId/graph-health` - Graph health summary
- `GET /api/tags` - List all tags
- `GET /api/tags/:name/memories` - Get memories with a tag
- `POST /api/tags` - Create a new tag
- `PATCH /api/tags/:id` - Rename a tag
- `DELETE /api/tags/:id` - Delete an unused tag

See `CLAUDE.md` for complete API endpoint documentation.

### Quick Project Discovery

- MCP: Call `list_projects()` to enumerate projects; optionally filter by `name` or `handle`.
- Shell: Use `mz-projects-list` from `lib/utils/khef.sh` to print project handles, or `mz-projects | jq -r '.projects[].display_name'` for names.

## Rules Management

Keep agent rules consistent and avoid duplicating them across projects by splitting global (user-level) rules from project-level overlays.

- Precedence (most specific wins):
  - `<project>/AGENTS.local.md` and `<project>/CLAUDE.local.md` (user-local, not in git)
  - `<project>/AGENTS.md` (repo-scoped, if present)
  - `~/.codex/AGENTS.md` (global)

- Sync commands:
  - Home-level (from reserved `user` project): `npm run sync:user-rules-to-disk`
    - Updates `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md` (marker-based, idempotent)
  - Project-level: `npm run sync:project-rules-to-disk [<handle|name|uuid>]`
    - Updates `<project>/AGENTS.local.md` and `<project>/CLAUDE.local.md` (marker-based, idempotent)

- Seeding defaults:
  - `npm run db:seed` seeds default agent rules into the reserved `user` project by default
  - Target a specific project with: `npm run db:seed -- <project-handle>`

- Database maintenance:
  - Dry-run duplicate cleanup outside `user`: `npm run db:task:rules:dedup`
  - Execute cleanup: `npm run db:task:rules:dedup -- --execute`

Tip: After `initialize_session`, compare returned `agent_rules` with local files (AGENTS.md/AGENTS.local.md/CLAUDE.local.md and home files). If they differ, run the appropriate sync command to resolve drift.

## Anti-Patterns to Avoid

1. **Don't duplicate information** - Use relations instead of copying content
2. **Don't over-document** - Create memories for significant items only
3. **Don't forget relations** - Isolated memories lose context
4. **Don't ignore assistant-rules** - Always check and follow project guidelines
5. **Don't leave orphaned memories** - Link new memories to existing graph

## Example Session

```
# Agent starts work on authentication feature

1. initialize_session(project_handle: "my-app")
   → Loads project, rules, and recent context in one call

2. search_memories(project_handle: "my-app", search: "auth")
   → Finds: Previous decision to use JWT

3. search_memories(project_handle: "my-app", type: "pattern", tag: "security")
   → Finds: Pattern for secure token storage

4. Implements feature following existing patterns

5. create_memory(
     type: "decision",
     content: "Use HTTP-only cookies for refresh tokens...",
     tags: ["auth", "security", "jwt"]
   )
   → decision_id: "new-123"

6. create_relation(
     source: "new-123",
     target: "jwt-decision-id",
     type: "supports"
   )

7. create_relation(
     source: "new-123",
     target: "security-pattern-id",
     type: "follows_from"
   )
```

Result: The agent has:
- Followed existing patterns
- Documented the new decision
- Linked it to the knowledge graph
- Made it discoverable for future agents

## Continuous Improvement

The memory system improves over time as agents:
1. Document decisions and patterns
2. Build a richer knowledge graph
3. Add more specific assistant-rules
4. Create better tags and organization

Each agent session should leave the project smarter than it found it.

**IMPORTANT**. The Khef API runs on the host machine, not inside Docker or a VM. Only the postgres database runs in Docker. Agents must connect to the host's MCP server (default: `http://localhost:3100`) to access khef functionality.
