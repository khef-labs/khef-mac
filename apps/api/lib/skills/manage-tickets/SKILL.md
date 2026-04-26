---
name: manage-tickets
description: This skill should be used when the user asks to "create a ticket", "add to board", "manage tickets", "create a collection board", "set up a sprint board", or needs to work with khef collections, board views, and ticket-type memories.
---

# Manage Tickets

Work with khef collections, board views, sub-collections, and ticket-type memories. Collections group memories with optional kanban board layout. Tickets are board-friendly memory types with inline expand and checklist support.

## Ticket Type Hierarchy

| Type | Parent | Purpose |
|------|--------|---------|
| `ticket` | (root) | Generic board card, parent type |
| `epic` | ticket | Large body of work containing stories |
| `story` | ticket | User-facing deliverable or feature |
| `spike` | ticket | Timeboxed research or exploration |
| `task` | ticket | Generic work item |

All children inherit ticket statuses: `open`, `in_progress`, `blocked`, `done`, `canceled`.

## Creating Tickets

Use `create_memory` with a ticket child type. Always include meaningful content for the board card description and checklist.

```
create_memory({
  project_id: "my-project",
  handle: "auth-flow-story",
  title: "Add OAuth2 authentication flow",
  type: "story",
  content: "## Acceptance Criteria\n\n- [ ] Login redirects to OAuth provider\n- [ ] Callback handles token exchange\n- [ ] Refresh token stored securely\n\n## Notes\n\nUse the existing session middleware.",
  tags: ["auth", "api"]
})
```

Checklist format in content (parsed by board view):
```
- [ ] Unchecked item
- [x] Checked item
```

## Collections and Sub-Collections

Collections group memories. Sub-collections enable hierarchy (single-level nesting only).

### Create a Root Collection

```
create_collection({
  project_id: "my-project",
  handle: "auth-project",
  name: "Auth Project",
  description: "Authentication feature work"
})
```

### Create a Board Sub-Collection

```
create_collection({
  project_id: "my-project",
  handle: "auth-sprint-1",
  name: "Sprint 1",
  parent_id: "<parent-collection-uuid>",
  view_mode: "board"
})
```

### View Modes

| Mode | Description |
|------|-------------|
| `list` | Default vertical list with reorder, filter, type badges |
| `board` | Kanban columns grouped by memory status |
| `grid` | Compact card grid for density |

### Add Memories to Collection

```
add_to_collection({
  project_id: "my-project",
  collection_id: "<collection-uuid>",
  memory_id: "<memory-uuid>"
})
```

## Board View

The board groups collection memories into columns by status. Each column corresponds to a status value (e.g., To Do, In Progress, Blocked, Done).

### Board Config

Hide specific columns per collection:

```
update_collection({
  project_id: "my-project",
  collection_id: "<collection-uuid>",
  board_config: { "hiddenColumns": ["canceled", "on_hold"] }
})
```

### Moving Cards Between Columns

Dragging a card between columns in the UI calls `update_memory_status`. Via MCP:

```
update_memory_status({
  memory_id: "<memory-uuid>",
  status: "in_progress"
})
```

## External Source Links

Tickets can link to external trackers (Jira, Linear, GitHub Issues) via metadata:

```
create_memory({
  project_id: "my-project",
  handle: "auth-login-story",
  title: "Implement login page",
  type: "story",
  content: "...",
  metadata: {
    "external-source-type": "linear",
    "external-source-url": "https://linear.app/team/AUTH-42",
    "external-source-id": "AUTH-42"
  }
})
```

Update external links on existing memories:

```
update_memory({
  memory_id: "<uuid>",
  metadata: {
    "external-source-type": "jira",
    "external-source-url": "https://jira.example.com/browse/PROJ-123",
    "external-source-id": "PROJ-123"
  }
})
```

The board view shows external links as a blue pill on card footers. The memory page shows them in collapsed metadata.

Required fields: `external-source-type` and `external-source-url`. The `external-source-id` is optional but recommended for display.

## Listing and Querying

### List Root Collections

```
list_collections({ project_id: "my-project", parent_id: "null" })
```

### List Sub-Collections of a Parent

```
list_collections({ project_id: "my-project", parent_id: "<parent-uuid>" })
```

### Get Collection with Children and Memories

```
get_collection({ project_id: "my-project", collection_id: "<uuid>" })
```

Returns sub-collections (if parent), view mode, board config, and all memories with position.

## Typical Workflow

1. Create a root collection for the project or feature area
2. Create board sub-collections for sprints or work phases (`view_mode: "board"`)
3. Create ticket memories (`story`, `task`, `epic`, `spike`) with checklists in content
4. Add tickets to the board sub-collection
5. Optionally set external source metadata for tracker links
6. Use `update_memory_status` to move tickets between columns
7. Use `board_config.hiddenColumns` to hide irrelevant status columns

## Tips

- Board columns derive from the statuses of the memory types in the collection. No manual column setup needed.
- Mixed types in one board work fine — columns are the union of all statuses present.
- Sub-collections cannot have children (single-level nesting enforced by DB trigger).
- Deleting a parent collection cascades to all sub-collections.
- The `position` field on `collection_memories` controls card order within a column.
- Use `reorder_collection` to change card positions.
