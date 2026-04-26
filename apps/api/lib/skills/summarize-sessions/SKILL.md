---
name: summarize-sessions
description: This skill should be used when the user says "summarize sessions", "add session summaries", "label sessions", "name sessions", or needs to generate short summary labels for sessions that are missing them. Also triggers for "rem sessions".
context: fork
---

# Summarize Sessions

Generate short summary labels for sessions that are missing them. Runs as a forked subagent, reads session content, generates concise labels, and writes them to the `sessions.summary` field via the `update_session` MCP tool.

## Arguments

`$ARGUMENTS` determines scope:

- **nickname** (e.g., `leann`) — summarize all sessions sharing that nickname (lineage)
- **session UUID** — summarize a single session
- **project handle** (e.g., `khef`) — summarize all sessions in that project missing summaries
- Empty — summarize all sessions missing summaries (up to 50)

## Workflow

### 1. Find Sessions to Summarize

Based on the argument type:

**Nickname:**
```
get_session_lineage(nickname: "<name>")
```
Filter to sessions where summary is null or empty.

**Session UUID:**
```
get_session_by_id(session_id: "<uuid>")
```

**Project handle or empty:**
```
query_khef(sql: "SELECT s.id, s.session_id, s.nickname, s.summary, s.message_count, s.started_at FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE (s.summary IS NULL OR s.summary = '') AND p.handle = '<handle>' ORDER BY s.started_at DESC LIMIT 50")
```

For empty args, omit the project filter.

### 2. For Each Session, Gather Content

Try sources in this order (stop at the first that has content):

**a) Session summary snapshots** (best quality — already LLM-generated):
```
get_session_summary(id: "<session-db-id>")
```
If this returns content, use it directly as the source material.

**b) Session chunks** (raw transcript):
```
get_session_by_id(session_id: "<uuid>", include_chunks: true)
```
Read the first 3-5 chunks to understand what was worked on.

### 3. Generate Summary Label

From the gathered content, write a **5-15 word summary** that captures the main focus of the session. Think of it as a commit message for the session.

Good examples:
- "Read hook line-range fix and session start marker reset"
- "Unified Sessions page with nickname display"  
- "Kdag executor tilde expansion and spawn fix"
- "OpenAPI spec linting and redocly config"

Bad examples (too vague):
- "Bug fixes and improvements"
- "Working on the project"
- "Various changes"

### 4. Write the Summary

```
update_session(session_id: "<uuid>", summary: "<generated summary>")
```

### 5. Report Results

After processing all sessions, print a summary:

```
Summarized N sessions:
- leann: "Read hook line-range fix and session start marker reset"
- tove: "SearchPage clear button and result clearing"
- issy: "Kdag executor improvements and error handling"
Skipped M sessions (already had summaries)
```

## Important Notes

- Keep summaries concise — they display in a compact list view
- Focus on *what was done*, not process details
- If a session has very few messages (< 5), it may not have enough content for a meaningful summary — write what you can or skip
- If the session content is mostly about setting up or debugging infrastructure, still summarize what the goal was
- Never overwrite an existing non-empty summary unless explicitly asked
