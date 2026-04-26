# khef MCP Server

Model Context Protocol (MCP) server that enables AI agents to interact with the khef API for storing and retrieving project memories.

## Features

- **Session Initialization** - Single-call startup to retrieve all relevant project context
- **Project Management** - Get projects by handle, name, or UUID (case-insensitive)
- **Memory Operations** - Create, update, and search memories with full-text search
- **Cross-Project Search** - Search memories across all projects or filter to one
- **User Project** - Reserved "user" project for general/user memories with cross-project relations
- **Relations** - Create typed relations between memories and traverse knowledge graphs
- **Agent Rules** - Dedicated tool for fetching agent behavioral guidelines
- **Auto-chunking** - Handles large content (>2000 chars) automatically
- **Full-text Search** - PostgreSQL-powered search with ranking

## The "user" Project

A reserved project with handle `user` is automatically created for general/user memories not tied to a specific development project:

```
Tool: create_memory
Args: {
  project_id: "user",
  title: "Git workflow preference",
  content: "Always rebase before merging to keep history linear",
  type: "user-note"
}
```

**Key features:**
- Created automatically via migration (cannot be deleted)
- Memories in `user` can relate to memories in any other project
- Use for cross-cutting knowledge, personal preferences, global patterns
- `initialize_session("user")` returns your personal context

**Example: Link personal preference to project decision:**
```
Tool: create_relation
Args: {
  source_memory_id: "<user-project-memory-id>",
  target_memory_id: "<other-project-memory-id>",
  relation_type: "supports"
}
```

## Installation

### Repo Dev Setup (recommended)

Install git hooks to ensure the MCP build stays in sync with source:

```
bash scripts/setup-hooks.sh
```

This enables a pre-commit hook that rebuilds the MCP server and blocks the commit if `mcp-server/build` changes (you'll need to stage those changes and commit again).

Helpful scripts from repo root:

- `npm run mcp:build` – build the MCP server
- `npm run mcp:verify` – build and verify that `mcp-server/build` matches source

At runtime, the MCP server logs a warning if the build is older than the source: run `npm run mcp:build` to refresh.

### For Claude Desktop

1. Build the MCP server:
```bash
cd mcp-server
npm install
npm run build
```

2. Add to your Claude Desktop config:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "khef": {
      "command": "node",
      "args": ["/absolute/path/to/khef/mcp-server/build/index.js"],
      "env": {
        "KHEF_API_URL": "http://localhost:3100"
      }
    }
  }
}
```

3. Restart Claude Desktop

### For Claude Code

1. Build the MCP server:
```bash
cd mcp-server
npm install
npm run build
```

2. Add to your user-scoped configuration using the CLI:
```bash
claude mcp add --scope user khef -- node /absolute/path/to/khef/mcp-server/build/index.js
```

3. Add the environment variable to `~/.claude.json`:
```bash
jq '.mcpServers."khef".env = {"KHEF_API_URL": "http://localhost:3100"}' ~/.claude.json > ~/.claude.json.tmp && mv ~/.claude.json.tmp ~/.claude.json
```

4. Verify the server is connected:
```bash
claude mcp list
```

5. Restart your Claude Code session or type `/mcp` to see available tools

**Note:** Replace `/absolute/path/to/khef` with your actual project path.

### For Other MCP Clients

The server uses stdio transport and can be integrated with any MCP-compatible client:

```bash
# Run directly
npm run dev

# Or use the built version
node build/index.js
```

## Configuration

### Environment Variables

- `KHEF_API_URL` - API endpoint (default: `http://localhost:3100`)

### Running the khef API

The MCP server requires the khef API to be running:

```bash
# In the main khef directory
npm run db:up
npm run db:migrate
npm run dev
```

## Available Tools

### `get_project`
Get a project by name. Returns project details including the project_id needed for other operations.

```typescript
{
  name: string  // Project name to search for
}
```

### `initialize_session`
**Recommended first call** - Initialize a new session by retrieving all relevant project context in one efficient call. Returns project info, active todos, and recent decisions/patterns/context.

```typescript
{
  project_handle?: string  // Preferred
  project_id?: string      // UUID
  project_name?: string    // Name
}
```

**Returns:**
```typescript
{
  project: Project,
  todos: {
    recently_created: MemorySummary[],  // Last 5 open (titles only)
    in_progress: MemorySummary[],       // In-progress (titles only)
    recently_completed: MemorySummary[] // Last 3 done (titles only)
  },
  recent_decisions: MemorySummary[], // Up to 5 (titles only)
  recent_patterns: MemorySummary[],  // Last 5 (titles only)
  recent_context: MemorySummary[]    // Last 5 (titles only)
}

// MemorySummary = { id, project_id, title, type, status, created_at, updated_at }
// Use search_memories to fetch full content when needed
```

### `search_memories`
Search and filter memories with full-text search across content AND tags, type/tag filters, and pagination. Supports cross-project search when `project_id` is omitted.

**Returns compact results by default** with `content_excerpt` (~240 chars) instead of full content. Use `get_memory_by_id` to fetch full content for specific memories.

Relevance ranking (when `q` is present):
- Uses `websearch_to_tsquery('english', q)` for natural query semantics
- Source weights: `title × 1.5`, `content × 1.0`, `chunks × 0.8`, `tags × 0.05`
- Title hits outrank content; content outranks tag-only matches

Zero-result fallback:
- If a strict query returns no results, the API attempts a best‑effort fallback using the first few terms as an ANY‑OF match (word‑boundary prefix via `to_tsquery('term:*')`), with a small score penalty so strict matches always outrank fallback.

Sorting:
- `sort`: one of `relevance`, `updated_at`, `created_at`, `title`
- `order`: `asc` or `desc` (ignored for `relevance`)
- Defaults: when `q` is present → `sort=relevance`; otherwise → `sort=updated_at desc`

```typescript
{
  project_id?: string      // Project handle, name, or UUID. If omitted, searches all projects.
  search?: string          // Full-text search query (searches content AND tags)
  sort?: string            // 'relevance' | 'updated_at' | 'created_at' | 'title'
  order?: string           // 'asc' | 'desc' (ignored for relevance)
  type?: MemoryType        // Filter by type
  tag?: string             // Filter by tag
  status?: string          // Filter by status (e.g., 'open', 'done', 'active')
  limit?: number           // Results per page (default: 20)
  offset?: number          // Skip results (default: 0)
  compact?: boolean        // Return compact format (default: true)
}
```

**Cross-project search example:**
```
Tool: search_memories
Args: { search: "authentication", type: "decision", sort: "relevance" }
Returns: Decisions about authentication from ALL projects (matches in content or tags)
```

### `search_content`
Search memories by content only (excludes tag matching). Use when you want to search only within memory text.

**Returns compact results by default.** Use `compact: false` or `get_memory_by_id` for full content.

```typescript
{
  project_id?: string      // Project handle, name, or UUID. If omitted, searches all projects.
  search: string           // Full-text search query (content only)
  type?: MemoryType        // Filter by type
  tag?: string             // Filter by tag
  status?: string          // Filter by status
  limit?: number           // Results per page (default: 20)
  offset?: number          // Skip results (default: 0)
  compact?: boolean        // Return compact format (default: true)
}
```

### `search_tags`
Search memories by tag names only. Use when you want to find memories that have tags matching a search term.

**Returns compact results by default.** Use `compact: false` or `get_memory_by_id` for full content.

```typescript
{
  project_id?: string      // Project handle, name, or UUID. If omitted, searches all projects.
  search: string           // Search query for tag names (case-insensitive partial match)
  type?: MemoryType        // Filter by type
  status?: string          // Filter by status
  limit?: number           // Results per page (default: 20)
  offset?: number          // Skip results (default: 0)
  compact?: boolean        // Return compact format (default: true)
}
```

### `get_memory_by_id`
Fetch a memory by UUID (full content).

```typescript
{
  memory_id: string  // Memory ID (UUID)
}
```

### `create_memory`
Create a new memory. Content over 2000 chars is automatically chunked. Returns a compact response by default (id, handle, status, timestamps). Use the API with `?compact=false` for full content in the response.

```typescript
{
  project_id: string       // Project ID (UUID)
  title: string            // Memory title (max 200 chars, unique within project)
  content: string          // Memory content
  type: MemoryType         // Memory type
  tags?: string[]          // Optional tags
}
```

**Memory Types:**
- `user-note`, `assistant-note`, `project-note`
- `user-todo`, `assistant-todo`
- `knowledge` (parent type grouping `commands`, `context`, `pattern`)
- `decision`, `command`, `api`, `reference`, `assistant-rule`, `diagram`

### `update_memory`
Update an existing memory. Partial updates supported. Returns a compact response by default.

```typescript
{
  project_id?: string      // Optional — auto-resolved from the memory if omitted
  memory_id: string        // Memory ID (UUID)
  title?: string           // New title (max 200 chars, unique within project)
  content?: string         // New content
  type?: MemoryType        // New type
  tags?: string[]          // Replace all tags
}
```

### `append_memory`
Append content to an existing memory without replacing it. Useful for accumulating notes or building up documentation incrementally. Returns a compact response by default.

```typescript
{
  project_id?: string      // Optional — auto-resolved from the memory if omitted
  memory_id: string        // Memory ID (UUID)
  content: string          // Content to append
  separator?: string       // Separator between existing and new content (default: "\n\n")
}
```

### `delete_memory`
Delete a memory by ID. Permanently removes the memory, its chunks, and relations.

```typescript
{
  project_id?: string      // Optional — auto-resolved from the memory if omitted
  memory_id: string        // Memory ID (UUID) to delete
}
```

### `get_memory_type_statuses`
List the valid status values for a memory type.

```typescript
{
  memory_type: string  // Memory type (e.g., "user-todo", "decision")
}
```

### `get_project_memory_type_statuses`
Project-scoped status usage counts for a memory type.

```typescript
{
  project_id: string  // Project handle, name, or UUID
  memory_type: string // Memory type (e.g., "assistant-todo")
}
```

### `get_memory_status`
Get the current status of a memory.

```typescript
{
  memory_id: string  // Memory ID (UUID)
}
```

### `update_memory_status`
Set or update the status of a memory. Status values are type-specific; use `get_memory_type_statuses` to discover valid statuses.

```typescript
{
  project_id: string  // Project handle, name, or UUID
  memory_id: string   // Memory ID (UUID)
  status: string      // Status value (type-specific)
}
```

### `create_relation`
Create a typed relation between two memories. Relations can be within the same project, or cross-project if one memory is in the "user" project.

```typescript
{
  source_memory_id: string       // Source memory ID (UUID)
  target_memory_id: string       // Target memory ID (UUID)
  relation_type: RelationType    // Relation type
}
```

**Relation Types:**
- `relates_to` - General relationship
- `contradicts` - Conflicting information
- `supports` - Supporting evidence
- `depends_on` - Dependency
- `follows_from` - Temporal sequence
- `references` - Reference link

### `suggest_relations`
Suggest related memories for linking based on the source memory's content and tags. Excludes already-related memories.

```typescript
{
  project_id: string  // Project handle, name, or UUID
  memory_id: string   // Memory ID (UUID)
  limit?: number      // Maximum number of suggestions (default: 10)
}
```

### `get_memory_graph`
Traverse a memory's relation graph to build a knowledge graph.

```typescript
{
  memory_id: string    // Starting memory ID (UUID)
  depth?: number       // Traversal depth (default: 2)
}
```

Returns nodes (memories), edges (relations), and `max_depth` (the deepest traversal level reached). Use `max_depth` to detect the full extent of the graph without over-fetching.

### `get_agent_rules`
Get all active assistant-rule memories for a project. These contain behavioral guidelines, commit message rules, coding standards, etc.

```typescript
{
  project_id: string   // Project ID (UUID)
}
```

### `get_graph_health`
Analyze the knowledge graph health for a project to identify orphans and connectivity issues.

```typescript
{
  project_id: string  // Project handle (e.g., 'khef'), name, or UUID
}
```

Returns a summary with counts (memories, relations, components), orphan list, relation type distribution, and memory-type stats.

### `get_project_memory_types`
List memory types for a project with usage counts.

```typescript
{
  project_id: string  // Project handle, name, or UUID
}
```

### `get_commits`
Get commit history for a project. Requires project to have a configured path that is a git repository.

```typescript
{
  project_id: string   // Project handle, name, or UUID
  branch?: string      // Branch name (default: current branch)
  limit?: number       // Max commits to return (default: 20)
  path?: string        // Filter commits to specific file/directory
}
```

### `get_diff`
Get diff content for a specific commit or working tree changes. Returns unified diff format with stats.

```typescript
{
  project_id: string    // Project handle, name, or UUID
  commit_sha?: string   // Commit SHA (omit for working tree changes)
  path?: string         // Filter diff to specific file/directory
}
```

### `annotate_commit`
Add a review comment to a commit's diff. Creates a diff record if one doesn't exist. Supports anchor_text for inline comments on specific code.

```typescript
{
  project_id: string      // Project handle, name, or UUID
  commit_sha: string      // Commit SHA to annotate
  content: string         // Comment content
  anchor_text?: string    // Exact text in diff to anchor comment to
  anchor_prefix?: string  // Context before anchor_text for disambiguation
  anchor_suffix?: string  // Context after anchor_text for disambiguation
  path?: string           // Filter to specific file path
}
```

### `get_commit_comments`
Get all review comments for a specific commit. Returns empty array if no comments exist.

```typescript
{
  project_id: string   // Project handle, name, or UUID
  commit_sha: string   // Commit SHA to get comments for
  path?: string        // Filter to specific file path
}
```

## Usage Examples

### Agent Session Workflow

**Recommended workflow with initialize_session:**

```
1. Agent starts working on project
   → initialize_session(project_id: "khef")  // Use project handle directly
   → Receives all context in one call (project, rules, todos, recent decisions/patterns/context)

2. Agent searches for specific context if needed
   → search_memories(project_id: "...", search: "authentication")
   → Finds additional relevant decisions and patterns

3. Agent makes a decision
   → create_memory(
       project_id: "...",
       title: "Use JWT for authentication",
       content: "Use JWT for auth because...",
       type: "decision",
       tags: ["auth", "jwt"]
     )

4. Agent links related knowledge
   → create_relation(
       source_memory_id: "new-decision-id",
       target_memory_id: "related-pattern-id",
       relation_type: "supports"
     )
```

**Legacy workflow (still supported but less efficient):**

```
1. Agent starts working on project
   → get_project(name: "khef")
   → get_agent_rules(project_id: "...")
   → search_memories(project_id: "...", type: "assistant-todo", status: "open")
   → search_memories(project_id: "...", type: "decision")
   → ...multiple calls to gather context
```

### Example: Finding Agent Rules

```
Tool: get_project
Args: { name: "khef" }
Returns: { "id": "abc-123", "name": "khef", ... }

Tool: get_agent_rules
Args: { project_id: "abc-123" }
Returns: {
  "memories": [
    {
      "content": "Exclude agent signature lines from commits",
      "type": "assistant-rule",
      "tags": ["git", "commits"]
    }
  ],
  "pagination": { "total_count": 1, ... }
}
```

### Example: Creating and Linking Memories

```
Tool: create_memory
Args: {
  project_id: "abc-123",
  title: "Use Fastify for better TypeScript support",
  content: "Use Fastify for better TypeScript support because it has first-class TypeScript definitions and better async/await handling than Express.",
  type: "decision",
  tags: ["framework", "typescript"]
}
Returns: { "memory": { "id": "mem-456", ... } }

Tool: create_relation
Args: {
  source_memory_id: "mem-456",
  target_memory_id: "existing-pattern-id",
  relation_type: "supports"
}
```

### Relation Templates

Use these patterns to create consistent, meaningful relations. The **source** is the memory you're linking FROM, the **target** is what it links TO.

#### When to Use Each Relation Type

| Relation | Use When | Direction (Source → Target) |
|----------|----------|----------------------------|
| `supports` | Evidence backs up a claim | Evidence → Claim |
| `contradicts` | Information conflicts | Newer → Older (supersedes) |
| `depends_on` | Can't exist without the other | Dependent → Dependency |
| `follows_from` | Caused by or derived from | Effect → Cause |
| `references` | Mentions or cites | Referrer → Referenced |
| `relates_to` | Loosely connected (last resort) | Either direction |

#### Common Patterns

**Decision supersedes another decision:**
```
Source: "Use PostgreSQL for all data" (new decision)
Target: "Use SQLite for local dev" (old decision)
Type: contradicts
Why: New decision invalidates/replaces the old one
```

**Pattern supports a decision:**
```
Source: "Repository pattern for data access" (pattern)
Target: "Use clean architecture" (decision)
Type: supports
Why: The pattern provides evidence/implementation for the decision
```

**Context explains a decision:**
```
Source: "Team has PostgreSQL expertise" (context)
Target: "Use PostgreSQL for all data" (decision)
Type: supports
Why: Context provides rationale for the decision
```

**Decision depends on context:**
```
Source: "Use AWS Lambda for compute" (decision)
Target: "Budget constraint: $500/month" (context)
Type: depends_on
Why: Decision only makes sense given the constraint
```

**Implementation follows from decision:**
```
Source: "JWT token validation middleware" (pattern)
Target: "Use JWT for authentication" (decision)
Type: follows_from
Why: Pattern was created as a result of the decision
```

**Todo tracks a decision:**
```
Source: "Implement rate limiting" (todo)
Target: "Add API rate limits" (decision)
Type: relates_to
Why: Todo is work item for the decision (loose connection)
```

**Memory references external doc:**
```
Source: "OAuth2 implementation notes" (context)
Target: "RFC 6749 OAuth2 spec" (reference)
Type: references
Why: Internal notes cite external documentation
```

#### When NOT to Create Relations

- **Don't force it**: If you're unsure which type fits, the memories might not be related
- **Don't create circular chains**: A→B→C→A creates confusion
- **Don't duplicate**: One relation per pair is enough
- **Don't over-link**: 2-4 relations per memory is typical; more suggests over-engineering

## Development

```bash
# Install dependencies
npm install

# Run in development mode with auto-reload
npm run dev

# Build for production
npm run build

# Watch mode for development
npm run watch
```

## Troubleshooting

### "API request failed" errors
- Ensure khef API is running on the configured URL
- Check `KHEF_API_URL` environment variable
- Verify the API is accessible: `curl http://localhost:3100/health`

### Port changes not picked up
- If you change the khef API port or `KHEF_API_URL`, restart the client so it picks up the new endpoint.
- Claude Desktop/Code: quit and reopen (or reload the window) to reinitialize the MCP server.
- Codex CLI: exit and restart the CLI, or relaunch your terminal with the updated env.
- Confirm the new URL is live: `curl http://localhost:$PORT/health`.

### Server not appearing in Claude Desktop
- Check the config file path is correct
- Ensure the `command` path is absolute
- Restart Claude Desktop completely
- Check Claude Desktop logs for errors

### TypeScript build errors
- Run `npm install` to ensure dependencies are installed
- Check Node.js version (requires Node 16+)

## Architecture

```
Claude Desktop
    ↓ (stdio)
MCP Server
    ↓ (HTTP)
khef API
    ↓ (PostgreSQL)
Database
```

The MCP server acts as a bridge between MCP clients (like Claude Desktop) and the khef REST API, translating MCP tool calls into HTTP requests.

## License

MIT
