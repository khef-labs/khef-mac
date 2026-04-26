---
name: rem
description: This skill should be used when the user says "rem", "consolidate memories", "tidy up", "clean up memories", "memory hygiene", "prune snapshots", "review project knowledge", or needs to scan and report on stale, duplicate, or outdated memories, collections, snapshots, orphaned files, and project knowledge.
context: fork
---

# REM

Memory consolidation scan — review and report on khef memory hygiene for a project. Named after REM sleep, where the brain consolidates and prunes memories. Runs as a forked subagent, writes a report memory, and returns the UUID for interactive execution via `/rem-exec`.

Unlike auto-dream (which rewrites flat markdown files), REM operates on structured khef data: typed memories with statuses, relations, tags, collections, and snapshots.

## Arguments

`$ARGUMENTS` determines scope:

- Empty or project handle → full project sweep (all phases)
- `collection <name or id>` → focus on a specific collection
- `snapshots` → focus on snapshot pruning only
- `files` → focus on orphaned file cleanup only
- `knowledge` → focus on project knowledge review only

## Phase 1: Scan

Assess the current state of the project. Run these in parallel:

### Memory Health
1. `get_graph_health(project_handle)` — orphan count, disconnected clusters
2. `search_memories(type: "assistant-todo", status: "open", project_id, sort: "updated_at", order: "asc", limit: 20)` — oldest open todos
3. `search_memories(type: "assistant-todo", status: "in_progress", project_id, sort: "updated_at", order: "asc", limit: 20)` — stale in-progress todos
4. `search_memories(type: "decision", status: "proposed", project_id, sort: "updated_at", order: "asc", limit: 20)` — decisions stuck in proposed
5. `search_memories(type: "context", status: "current", project_id, sort: "updated_at", order: "asc", limit: 20)` — context that may be outdated

### Collections
6. `list_collections(project_id)` — collections to review membership

### Snapshots
7. `query_khef(sql)` — find memories with high snapshot counts:
   ```sql
   SELECT m.id, m.title, m.handle, m.current_snapshot,
          COUNT(ms.id) as snapshot_count
   FROM memories m
   JOIN memory_snapshots ms ON ms.memory_id = m.id
   WHERE m.project_id = (SELECT id FROM projects WHERE handle = '<project>')
   GROUP BY m.id
   HAVING COUNT(ms.id) > 3
   ORDER BY COUNT(ms.id) DESC
   LIMIT 20
   ```

### Orphaned Files
8. `query_khef(sql)` — find uploaded files not referenced in any memory content:
   ```sql
   SELECT f.id, f.original_filename, f.mime_type, f.size, f.created_at
   FROM files f
   WHERE f.project_id = (SELECT id FROM projects WHERE handle = '<project>')
     AND NOT EXISTS (
       SELECT 1 FROM memories m
       WHERE m.project_id = f.project_id
         AND m.content LIKE '%' || f.id::text || '%'
     )
   ORDER BY f.created_at ASC
   ```

### Project Knowledge
9. `get_project_knowledge(project_handle)` — load current commands, context, and patterns
10. Cross-reference knowledge against the actual codebase:
    - **Commands**: verify scripts still exist in `package.json`, `Makefile`, or `scripts/` — flag commands that reference removed scripts or outdated flags
    - **Context**: check if described schemas, architecture, or config still match the codebase — flag context that describes removed tables, renamed files, or changed patterns
    - **Patterns**: verify workflows still apply — flag patterns that reference deprecated tools, changed processes, or outdated conventions

## Phase 2: Gather Signal

Search recent sessions for context that should inform consolidation:

1. `search_sessions(q: "decided to change", mode: "fulltext", limit: 5)` — recent decisions that may supersede old ones
2. `search_sessions(q: "no longer needed", mode: "fulltext", limit: 5)` — things explicitly marked as obsolete
3. `search_sessions(q: "actually we should", mode: "fulltext", limit: 5)` — corrections and reversals
4. `search_sessions(q: "added new command", mode: "fulltext", limit: 5)` — new commands or scripts not yet in project knowledge
5. `search_sessions(q: "changed the pattern", mode: "fulltext", limit: 5)` — workflow changes not yet captured

Cross-reference findings with scan results. Flag mismatches between what sessions say happened and what the memories/knowledge currently reflect.

## Phase 3: Write Report

Create a report memory with all findings and recommendations. Use `create_memory` with:

- **project_id**: the scanned project handle
- **type**: `assistant-note`
- **status**: `persistent`
- **handle**: `rem-report-<YYYYMMDD-HHmmss>` (timestamped for uniqueness)
- **title**: `REM Report: <project> (<date>)`
- **tags**: `rem`, `report`, `hygiene`

### Report Content Format

Structure the content with a section per category. Each recommendation includes the memory/file/collection ID so `/rem-exec` can act on it. Use checkbox markdown so progress can be tracked:

```markdown
## Stale Todos

- [ ] `<memory-id>` — **<title>** (last updated <date>)
  Action: `close` as `canceled` — not updated in 30+ days, work appears abandoned

- [ ] `<memory-id>` — **<title>** (last updated <date>)
  Action: `keep` — still referenced in recent session discussion

## Outdated Decisions & Context

- [ ] `<memory-id>` — **<title>** (status: proposed, last updated <date>)
  Action: `update-status` to `outdated` — session signal indicates this was reversed

## Orphan Memories

- [ ] `<memory-id>` — **<title>**
  Action: `connect` — suggest `supports` relation to `<target-memory-id>` (<target-title>)

## Collection Review

- [ ] Collection **<name>** (`<collection-id>`)
  - [ ] `<memory-id>` — **<title>** (status: done)
    Action: `remove-from-collection`

## Snapshot Pruning

- [ ] `<memory-id>` — **<title>** (snapshots: <count>)
  - Keep: #1 (original), #<current> (current)
  - Prune: #2, #3, #4 (intermediate manual edits)

## Orphaned Files

- [ ] `<file-id>` — **<filename>** (<size>, uploaded <date>)
  Action: `delete-file`

## Project Knowledge Updates

- [ ] **Commands** — `<knowledge-handle>`
  Current: `npm run old-script`
  Proposed: `npm run new-script` (script was renamed in package.json)

- [ ] **Context** — `<knowledge-handle>`
  Section: "<section-name>"
  Issue: references removed table `old_table`
  Proposed: update to reflect current schema
```

After creating the report memory, return a summary to the user:
- Counts per category (e.g., "5 stale todos, 3 orphans, 2 snapshots to prune")
- The report memory UUID and link: `http://localhost:5174/memories/<id>`
- Instruction: "Run `/rem-exec <uuid>` to review and execute recommendations"

## Important Notes

- This skill is scan-only — it never modifies, deletes, or updates any memories, files, or knowledge
- All recommendations go into the report memory for later execution via `/rem-exec`
- If scoped to a specific focus (`collection`, `snapshots`, `files`, `knowledge`), only scan and report on the relevant areas
- The 14-day and 30-day thresholds are guidelines — use judgment based on project activity level
