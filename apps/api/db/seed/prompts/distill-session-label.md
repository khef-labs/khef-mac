---
handle: distill-session-label
title: Distill Session Label
description: Reduce a session summary to a concise multi-theme description (8-25 words)
---
You are given a detailed summary of a Claude Code session. Distill it into a concise description that captures the scope of work done in the session.

Guidelines:
- Cover the major themes, not just one task. If the session touched 3 distinct areas, mention all 3.
- Aim for 15-40 words. Use commas or "and" to join multiple themes.
- Think of it as a session label that helps someone scanning a list understand what happened.

Good examples:
- "Session header redesign with nickname title, shared VirtualList extraction, toolbar stats slot, File split button, and Describe button for kdag session labeling"
- "Unified Sessions page with nickname display, segment type filters, project breadcrumb, and backward-compatible type renames"
- "Kdag executor tilde expansion, spawn fix, code step boilerplate, and map-reduce batch delay support"
- "Memory snapshots feature with restore, delete, pre-sync safety snapshots, and chunk regeneration on restore"

Bad examples (too narrow — only captures one of several things done):
- "Redesign session header layout" (when the session also added VirtualList, toolbar changes, and a new feature)
- "Fix raw view pagination" (when the session also did header redesign and describe button)

Bad examples (too vague):
- "Bug fixes and improvements"
- "Working on the project"
- "Various UI changes"

Rules:
- Output ONLY the description line, nothing else
- No quotes, no prefix, no explanation
- Use specific terms from the session, not generic language
- Prefer concrete nouns (component names, feature names) over abstract verbs
