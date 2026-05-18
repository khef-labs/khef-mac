---
name: rem-summary
description: This skill should be used when the user says "rem-summary", "curate this summary", "prune the session summary", "edit the session summary", "clean up the summary", or wants to revise a session's current summary snapshot — preserving substantive context (file paths, decisions, errors, open work) while removing process narration and other cruft.
---

# REM Summary

Revise a session's current summary snapshot to remove cruft while preserving the substantive record. The read-heavy archive-and-draft work runs in an isolated `session-historian` sub-agent, so this skill spends almost no context on the (often very large) summary text. The previous version is archived to disk before any rewrite.

Named after `/rem` — same hygiene philosophy, applied to session summary content rather than memory metadata. This skill is the orchestrator; the `session-historian` agent is the drafting engine.

## Argument

`$ARGUMENTS` is one of:

- A **session nickname** (e.g., `daveen`) — the common case. A nickname maps to a lineage of one or more sessions.
- A **session file UUID** (from the JSONL filename) or a **database row ID** — targets one session directly.

If omitted, ask which session to revise.

## Division of labor

- **The `session-historian` agent** (invoked via the Task tool) resolves the session, fetches the current summary, archives the original to disk, and drafts the revised version applying preservation/pruning rules. It writes the draft to a timestamped file and returns a structured report. **It never applies anything to the live snapshot.**
- **This skill** invokes the agent, relays its report to the user, gets approval, and — only then — applies the PATCH to the live snapshot.

The destructive write (PATCH) and the approval checkpoint always stay here in the main thread. The agent only ever archives and drafts.

## Workflow

### 1. Invoke the session-historian agent

The agent has no shell access and cannot compute its own timestamp, so compute one here first:

```bash
date +%Y%m%d-%H%M%S
```

Call the Task tool with `subagent_type: session-historian` and a prompt that includes **both** the raw session identifier from `$ARGUMENTS` **and** the timestamp `TS` you just computed (the agent uses `TS` for its archive and draft filenames). The agent runs in its own context and returns a structured report.

### 2. Handle the agent's report

- **`STATUS: NO_SUMMARY`** → tell the user there is no summary to curate. Stop.
- **`STATUS: NO_MCP`** → the agent had no khef MCP tools in this project's context. Tell the user to add `mcp__khef__*` to this project's `.claude/settings.local.json` allow list, then re-run `/rem-summary`. Stop.
- **`STATUS: AMBIGUOUS`** → the nickname maps to multiple summarized sessions. Show the user the candidate list and ask which one. Re-invoke the agent (step 1) with the chosen session's file UUID. Do not guess.
- **`STATUS: OK`** → continue to step 3. Capture from the report: `session_id`, `session_db_id`, `snapshot_id`, `archive_path`, `draft_path`, and `review_markers` (with any marker questions listed beneath the count). The agent does not report char counts — step 3 measures those from disk.

### 3. Present the draft to the user

This is a hands-off skill — the user wants to see the final draft and compare it against the original themselves. Do not relay section-by-section breakdowns, preserved-things lists, or editorial-decision rationales. Tell the user:

- **Compare Files URL** — the primary review surface. Format:

  ```
  http://localhost:5174/diff/files?a=<absolute archive_path>&b=<absolute draft_path>
  ```

  The agent reports `archive_path` and `draft_path` as paths relative to the khef repo. Prepend the current working directory (resolve once via `pwd`) so the URL contains absolute paths — `/api/fs/read` rejects relative paths.

- The **char reduction** — measure it from disk. The agent does not report this because its in-context measurements are unreliable (the `Read` tool returns line-numbered output, inflating naive `.length` counts). Compute the actual content sizes via shell:

  ```bash
  # Original content bytes — strip the archive header (a <!-- ... --> block + blank line that the agent prepends)
  ORIG=$(awk 'past_header { print } /^-->$/ { past_header=1; getline; next }' "<absolute archive_path>" | wc -c | tr -d ' ')
  REV=$(wc -c < "<absolute draft_path>" | tr -d ' ')
  REDUCTION=$((ORIG - REV))
  PCT=$(awk "BEGIN { if ($ORIG > 0) printf \"%.1f\", ($REDUCTION / $ORIG) * 100; else print 0 }")
  ```

  Report it as: `<ORIG> → <REV> chars (−<REDUCTION>, <PCT>%)`.
- The archive path and draft path on disk (fallback for manual inspection, and the archive is the recovery artifact if PATCH is rejected later).
- If the agent's `review_markers` count is greater than zero, list those markers — the few cases where the agent could not decide and explicitly asked.

The user reviews by opening the Compare Files URL (or reading the draft directly) and comparing it to the archive.

**Wait for explicit approval, modification request, or rejection before step 4. Never skip this checkpoint.**

### 4. Apply the revision

Only on approval:

1. Read the draft file at `draft_path`.
2. Resolve every `<!-- review: ... -->` marker per the user's instructions, then strip the markers. The marker syntax must never reach the live snapshot. If the user asked for other changes, make them in the draft text now.
3. Write the final content to `/tmp/rem-summary-apply.json` as `{"content": "<final text>"}` (a file avoids shell-quoting issues with multi-line content and apostrophes).
4. PATCH the live snapshot:

   ```bash
   curl -s -X PATCH http://localhost:3201/api/sessions/<session_id>/summary \
     -H 'Content-Type: application/json' \
     -d @/tmp/rem-summary-apply.json
   ```

   (`<session_id>` — the file UUID or DB row ID both work.)
5. Verify the response shows an updated `updated_at` timestamp.

### 5. Report

Tell the user:
- The archive path (so they can recover the prior version).
- Bytes saved: original vs final length, and the percentage reduction.
- The session link: `http://localhost:5174/sessions/<session_db_id>`.

## Important Notes

- **PATCH overwrites the current snapshot in place.** The DB does not retain the pre-rewrite content; the on-disk archive is the only record of what the snapshot used to say. Be deliberate.
- If the user rejects the draft, do nothing — the live snapshot stays untouched. Offer to re-invoke the agent with different guidance (e.g., "less aggressive pruning", "keep section X intact").
- If `<!-- review: ... -->` markers remain at PATCH time, stop and resolve them first. Never write them into the live snapshot.
- Only operate on the session the agent resolved in this invocation. Do not chain into other sessions without a fresh invocation.
- This skill only edits the **current** snapshot. To revise a historical snapshot, restore it via the UI first, then re-run `/rem-summary`.
- The kdag job `consolidate-session-summaries` is for *merging multiple snapshots into one*, not for pruning a single snapshot. Use that job for consolidation, this skill for curation.
- The `session-historian` agent is a user-level agent (`~/.claude/agents/session-historian.md`). It is not khef-seeded, so on a fresh machine it must be copied over alongside this skill.
