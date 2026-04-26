---
name: onboard
description: This skill should be used when the user says "onboard", "onboard me on", "catch me up on", "brief me on sessions", or wants to read context from multiple past sessions by nickname to get up to speed.
---

# Onboard

Read-only briefing from one or more session lineages. No nickname claiming, no handoff, no live coordination — just reads summaries and compactions from the named sessions and presents a consolidated briefing.

## Arguments

`$ARGUMENTS` is a comma-separated list of nicknames (e.g., "ridge,dulci,peak").

## Steps

### 1. Parse Nicknames

Split `$ARGUMENTS` on commas, trimming whitespace. If empty, tell the user to provide at least one nickname.

### 2. Export and Read Each Lineage

For each nickname, in order:

1. Call `export_session_lineage` with the nickname
2. Read the `00-lineage.json` file from the export path
3. Read the exported files chronologically:
   - Start with the earliest session directory
   - Read compaction files first (context from before compaction)
   - Then read summary snapshot files (AI-generated session summaries)
   - Proceed to the next session directory and repeat

Build a mental model per nickname of: what was worked on, key decisions, patterns established, and open/in-progress work.

### 3. Report

Present a consolidated briefing organized by nickname:

For each nickname:
- Session count and date range
- Key work completed
- Decisions made
- In-progress or open work

Then a cross-session summary:
- Common themes or shared context across the lineages
- Total estimated token cost (sum of all `estimated_tokens` from exports)

## Important Notes

- This is read-only — it does NOT claim any nicknames or affect session state
- If a nickname has no lineage (not found or no summaries), report it and continue with the rest
- Compaction summaries start with "User: This session is being continued from a previous conversation" — these contain structured context from Claude Code's auto-compaction
- Always read summaries chronologically to build context in the right order
