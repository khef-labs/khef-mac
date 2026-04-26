---
name: rem-exec
description: This skill should be used when the user says "rem-exec", "execute rem report", "apply rem recommendations", or provides a REM report memory UUID to interactively review and execute consolidation recommendations.
---

# REM Exec

Interactive execution of a REM consolidation report. Loads a report memory created by `/rem`, walks through each recommendation with the user, and executes approved changes.

## Arguments

`$ARGUMENTS` is the UUID of a REM report memory (created by `/rem`).

If no UUID is provided, search for the most recent REM report:
```
search_memories(q: "REM Report", type: "assistant-note", tag: "rem", sort: "created_at", order: "desc", limit: 1)
```

## Steps

### 1. Load the Report

Fetch the report memory via `get_memory_by_id`. Verify it's a REM report (tagged with `rem`, `report`). If not found or not a report, tell the user.

### 2. Present Overview

Summarize the report: counts per category, total recommendations. Ask the user how they want to proceed:
- **Category by category** (default) — walk through each section
- **Approve all** — execute everything without individual confirmation
- **Cherry-pick** — user names specific categories to address

### 3. Walk Through Recommendations

For each unchecked item (`- [ ]`) in the report:

1. Present the recommendation (memory title, current state, proposed action)
2. Wait for user approval: approve, skip, or modify
3. On approval, execute using the appropriate tool:
   - `update_memory_status` — for `close` and `update-status` actions
   - `create_relation` — for `connect`, `supersede`, and `merge` actions
   - `remove_from_collection` — for `remove-from-collection` actions
   - `delete_memory_snapshot` — for snapshot pruning
   - File deletion via API `DELETE /api/projects/:projectId/files/:fileId` — for `delete-file` actions
   - `set_project_commands` / `set_project_context` / `set_project_pattern` — for knowledge updates
4. After executing, update the checkbox in the report from `- [ ]` to `- [x]`

### Batch Approval

If the user says "approve all in this category" or "approve all remaining":
- Execute all unchecked items in the current category (or all categories)
- Check off each item as it's executed
- Report results after the batch

### 4. Save Progress

After processing items (or when the user says "done" / "stop"), update the report memory via `update_memory` with the checked-off content. This persists progress so the user can resume later with another `/rem-exec <uuid>` call.

### 5. Final Summary

Present:
- Changes made by category (counts)
- Items skipped or deferred (still unchecked)
- Link to graph health: `get_graph_health(project_handle)`
- If all items are addressed, update the report memory status to `transient`

## Important Notes

- Never delete memories — only update statuses, create relations, or remove from collections
- Never modify memory content (except the report itself for progress tracking)
- Snapshot deletion and file deletion are destructive — always confirm before executing
- Knowledge updates use upsert tools — confirm content changes with the user before applying
- The user can stop at any time and resume later — progress is saved to the report memory
- If an action fails, report the error, leave the item unchecked, and continue to the next item
