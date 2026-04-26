---
name: rehydrate
description: This skill should be used when the user says "rehydrate", "rebuild context", "catch up on this session", "what was I working on", or needs to restore context after a /compact in the current session.
---

# Rehydrate

Rebuild session context after a `/compact` event by reading your own session's lineage summaries and compaction files. Unlike `/continue-as`, this runs within the same session — no nickname claim, no handoff, no live session coordination.

## When to Use

After `/compact` strips detailed context from the conversation. The compaction summaries and any prior session summaries under your nickname still exist on disk — this skill reads them back in.

## Arguments

`$ARGUMENTS` is optional. If provided, it overrides the nickname to look up (useful if the auto-assigned nickname doesn't match the lineage you want). If omitted, use your current session's nickname.

## Steps

### 1. Resolve Your Nickname

If `$ARGUMENTS` is provided, use that as the nickname. Otherwise call `get_nickname` with your session ID to retrieve your current nickname.

### 2. Export the Lineage

Call `export_session_lineage` with the nickname. This writes all summaries and compaction summaries to disk, organized chronologically by session.

### 3. Read the Lineage Metadata

Read the `00-lineage.json` file from the export path. This tells you how many sessions exist, their dates, and how many summaries/compactions each has.

### 4. Read Summaries Chronologically

Read the exported files in order:
- Start with the earliest session directory
- Read compaction files first (these capture context from before the session was compacted)
- Then read summary snapshot files (these are the AI-generated session summaries)
- Proceed to the next session directory and repeat

Focus on building a mental model of: what was worked on, key decisions made, patterns established, and any open/in-progress work.

### 5. Check for Assigned Work

Search for open or in-progress assistant-todos in the current project:

```
search_memories(type: "assistant-todo", status: "open", project_id: "<current-project>")
search_memories(type: "assistant-todo", status: "in_progress", project_id: "<current-project>")
```

Cross-reference these with what the summaries describe as in-progress work.

### 6. Report

Summarize what you rebuilt:
- Number of sessions in the lineage and their date range
- Key work completed across the lineage
- Current state: what was in progress when compaction happened
- Open todos or unfinished tasks
- Estimated token cost of the catchup (from `export_session_lineage`)
- Confirm readiness to continue

## Important Notes

- This does NOT claim or change your nickname — you keep whatever was assigned at session start
- If your nickname has no lineage yet (first session, no prior compactions), say so and offer to check recent memories/todos instead
- Compaction summaries start with "User: This session is being continued from a previous conversation" — these contain structured context from Claude Code's auto-compaction
- Always read summaries chronologically to build context in the right order
