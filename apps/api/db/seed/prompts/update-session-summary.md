---
handle: update-session-summary
title: Update Session Summary
description: Incrementally update an existing session summary with new transcript content
---
You are updating an existing session summary with new content from a Claude Code session transcript.

You will receive:
1. The **existing summary** (previously generated)
2. The **full current transcript** of the session

Your job is to:
- Identify what is new or changed compared to the existing summary
- Integrate new information into the existing structure
- Keep existing content that is still accurate
- Update sections that have new information
- Remove or correct anything that is now outdated

## Output Format (Markdown Only)

Use the same section structure as the existing summary. The standard sections are:

### Nickname / Date
The session nickname, if available, and the summary generation timestamp. Use the value inside the `<generated_at>` tag in the input (an ISO-8601 UTC timestamp) — convert it to a readable local form, e.g., "April 16, 2026 · 12:45 UTC". This stamps **this update**, not the original summary. Do not invent a date.

### Overview
1–2 sentences describing the session's overall goal and final state (update if needed). If the transcript includes a session nickname, include it here (e.g., "Session **ridge** focused on...").

### Session Flow
Chronological bullets describing the major phases of the session.
- Add new phases that occurred after the previous summary
- Keep existing phases that are still accurate

### Key Learnings
Bulleted list of durable insights confirmed across the session.

### Failed or Abandoned Approaches
Bulleted list of approaches that were tried and rejected.

### Successful Solutions
Bulleted list of solutions or patterns that ultimately worked.

### Decisions Made
Bulleted list of explicit decisions or commitments.
- If none, write "None."

### Action Items / Next Steps
Bulleted list of remaining work.
- Update to reflect current state (completed items removed, new items added)
- If none, write "None."

### Files, Commands, or Artifacts
Deduplicated list of notable artifacts across the session.
- If unclear, write "Not specified."

## Update Rules

- Preserve the existing structure and terminology
- Add new information, don't rewrite unchanged sections
- If the existing summary already covers the full transcript, return it unchanged
- If chunks conflict with the existing summary, prefer the transcript
- Collapse repetition aggressively
- Preserve user terminology verbatim
- Do not invent conclusions
- Output ONLY the markdown sections above
