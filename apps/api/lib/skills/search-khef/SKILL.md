---
name: search-khef
description: This skill should be used when the user says "sss", "search khef", "search source code", "search commits", "search memories", "search sessions", "find in code", "find in khef", or needs to search across khef's indexed knowledge (source code, commits, memories, sessions, slack).
---

# Search Khef

Comprehensive search across all khef-indexed knowledge. Run searches in parallel when multiple backends are relevant.

## Search Backends

| Backend | Tool | Best For |
|---------|------|----------|
| Source code | `search_source_code` | Implementations, patterns, conventions |
| Commits | `search_commits` | When a feature was added, bug fixes, changelog |
| Memories | `search_memories` | Decisions, context, patterns, todos, rules |
| Sessions | `search_sessions` | Past conversations, implementation details |
| Slack | `search_slack` | Team discussions, decisions made outside code |

## Query Construction

Keep queries to **2-4 core terms**. Extra terms dilute results across all backends.

| Terms | Effect |
|-------|--------|
| 2-3 | Tight focus, best ranking |
| 4 | Still good, slight broadening |
| 5+ | Diluted — fulltext matches noise, semantic vectors drift |

## Execution Strategy

1. **Parse user intent** from `$ARGUMENTS` to determine which backends to search
2. **Default: search all relevant backends in parallel** — source code, commits, and memories at minimum
3. **Add sessions and slack** when the query is about past discussions, decisions, or context not likely in code
4. **Present results grouped by backend** with the most relevant matches first

## Backend-Specific Tips

### Source Code (`search_source_code`)
- Pass `language` filter when you know the target (e.g., `typescript`, `python`)
- Pass `repo` filter to narrow to a specific repository
- Scores above 0.5 = strong match; below 0.3 = tangential

### Commits (`search_commits`)
- Use `repo`, `since`, `until`, `author` filters to narrow scope
- Short queries (2-3 terms) rank the most relevant commit highest

### Memories (`search_memories`)
- Try `mode: 'keyword'` first, then `mode: 'semantic'` if results are sparse
- Use `type`, `status`, `tag` filters to narrow (e.g., `type: 'decision'`, `tag: 'api'`)

### Sessions (`search_sessions`)
- Try `mode: 'fulltext'` first (most reliable), then `mode: 'keyword'`, then `mode: 'semantic'`
- Set `include_thinking: false` for cleaner output

### Slack (`search_slack`)
- Best for team discussions and decisions made in conversation

## Output Format

Present results clearly:
- Group by backend with a heading
- Show the top 3-5 results per backend
- Include scores and brief excerpts
- Highlight the single most relevant result across all backends
