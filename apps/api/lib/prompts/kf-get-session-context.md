# Get Session Context

Retrieve all session context in a single MCP call using initialize_session.

**IMPORTANT:** Call initialize_session directly - do NOT call get_project first.

Use `project_handle` for clarity. The tool also accepts `project_id` (UUID) and `project_name` as optional alternatives.

**Example for ~/projects/dev-guide:**
```
khef - initialize_session (MCP)(project_handle: "dev-guide")
```

**Example for ~/projects/khef:**
```
khef - initialize_session (MCP)(project_handle: "khef")
```

## Response Contents

The initialize_session call returns all context in one response:

| Field | Content | Details |
|-------|---------|---------|
| `project` | Project info | Full project object |
| `todos.recently_created` | Last 5 open todos | Titles only |
| `todos.in_progress` | In-progress todos | Titles only |
| `todos.recently_completed` | Last 3 done todos | Titles only |
| `recent_decisions` | Recent decisions | Titles only (API may return up to 10) |
| `recent_patterns` | Last 5 patterns | Titles only |
| `recent_context` | Last 5 context | Titles only |

**Note:** Most items return summaries (titles only) to keep the response lightweight. Use `search_memories` to fetch full content when needed.

## Presentation Defaults

When presenting session context to the user, keep it concise:

- Do not list agent rules (they live in project/local agent files).
- Show at most 5 recent decisions (titles only).
- Summarize todos as counts with up to 3 example titles for "open" and "done".
- Include project name, handle, and UUID on one line.

## Fetching Full Content

To get the full content of a memory from the summaries:

```
search_memories(project_id: "<project-uuid>", search: "<memory title>")
```

Or use the memory ID directly with the API if available.
