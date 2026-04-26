---
name: continue-as
description: This skill should be used when the user says "continue as X", "pick up as X", "resume as X", "take over as X", or wants to start a fresh session that continues the work of a previous session identified by its nickname.
---

# Continue As

Handoff protocol for continuing a previous session's work under the same nickname. This enables session lineage — multiple sessions sharing a nickname form a logical thread of work.

## Arguments

`$ARGUMENTS` is the nickname to continue as (e.g., "dulci", "ridge").

## Steps

Execute these steps in order:

### 1. Claim the Nickname

Call `claim_nickname` with your session ID and the requested nickname from `$ARGUMENTS`.

Then update the iTerm2 badge to reflect the claimed nickname by running:

```bash
osascript -e 'tell application "iTerm2" to tell current session of current tab of current window to set variable named "user.claude_nickname" to "<NICKNAME>"' > /dev/null 2>&1
```

Replace `<NICKNAME>` with the actual claimed nickname. This uses osascript to talk to iTerm2 directly — escape sequences via `/dev/tty` don't work from Claude's Bash tool.

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

Build a mental model of: what was worked on, key decisions made, patterns established, and any open/in-progress work.

### 5. Check for Live Sessions

Call `list_active_sessions` and look for other sessions sharing this nickname (excluding yourself).

**If live sessions exist with this nickname:**
- Send a live message introducing yourself: "New session continuing as [nickname]. Reading through the lineage now. Any context I should know about current state or in-progress work?"
- Check for a response with `check_live_messages` (use `peek: true` to preserve)
- Inform the user that another session is still active — they can close it when the handoff is complete

**If no live sessions share the nickname:**
- The previous session has ended. Your context from the summaries is the complete picture.

### 6. Report

Summarize what you learned from the session lineage:
- Number of previous sessions and their date range
- Key work completed across the lineage
- Any in-progress work, open todos, or unfinished tasks
- Whether a live handoff is in progress
- Estimated token cost of the catchup (reported by `export_session_lineage` as `estimated_tokens`)
- Confirm readiness to continue

## Important Notes

- Multiple sessions CAN share a nickname simultaneously — this is by design for handoff
- During handoff, messages sent to the shared nickname are broadcast to all sessions with that name
- The user will close the old session when satisfied with the handoff
- Always read summaries chronologically to build context in the right order
- Do not assume context from the nickname alone — always read the actual summaries
- Compaction summaries start with "User: This session is being continued from a previous conversation" and contain structured context from Claude Code's auto-compaction
