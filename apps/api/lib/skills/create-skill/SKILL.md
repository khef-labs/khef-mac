---
name: create-skill
description: This skill should be used when the user asks to "create a skill", "add a skill", "new skill", "make a skill", "build a skill", or needs to scaffold a Claude Code skill with proper structure, frontmatter, and placement.
---

# Create Skill

Scaffold a new Claude Code skill with correct structure, frontmatter, and placement.

## Gather Requirements

Before writing anything, determine:

1. **Name** — kebab-case identifier (e.g., `review-python`, `extract-video-frames`)
2. **Purpose** — what the skill does in one sentence
3. **Trigger phrases** — 3-6 phrases a user would say to invoke it
4. **Behavior** — auto-trigger on intent, or explicit `/name` invocation only?

If `$ARGUMENTS` contains a skill name or description, use it. Otherwise ask.

## Directory Structure

```
<name>/
├── SKILL.md          # Required — frontmatter + instructions
├── references/       # Optional — detailed docs loaded on demand
├── examples/         # Optional — working code examples
├── scripts/          # Optional — executable utilities
└── assets/           # Optional — templates, files used in output
```

Only create `SKILL.md` unless the skill genuinely needs bundled resources.

## Placement

### Khef Built-In (syncable, preferred for khef skills)

```
apps/api/lib/skills/<name>/SKILL.md
```

- **Source of truth** for skills managed by the khef project
- Synced to `~/.claude/skills/<name>/SKILL.md` via `npm run db:seed:sync`
- Also synced via API: `POST /api/assistants/claude-code/commands/sync`
- Use this for any skill that is part of the khef system (search, video, kdag, etc.)
- After creating or editing, run `npm run db:seed:sync` to deploy

### User-Level (cross-project, immediate)

```
~/.claude/skills/<name>/SKILL.md
```

- Available in all projects immediately after creating
- No sync or build step needed
- Good for personal utilities, reviewers, tutors, general-purpose tools
- **Note:** Khef built-in skills sync here as their deploy target — don't edit directly if the source lives in `apps/api/lib/skills/`

### Project-Level (scoped to one repo)

```
<project>/.claude/skills/<name>/SKILL.md
```

- Only active when working inside that project
- Overrides a user-level skill with the same name
- Good for project-specific workflows and conventions

## SKILL.md Format

### Frontmatter (YAML)

```yaml
---
name: skill-name
description: This skill should be used when the user asks to "phrase 1", "phrase 2", or needs help with X.
---
```

**Required fields:**
- `name` — matches the directory name
- `description` — third-person sentence starting with "This skill should be used when..." listing trigger phrases in quotes

**Optional fields:**

| Field | Default | Purpose |
|-------|---------|---------|
| `disable-model-invocation` | `false` | Set `true` for user-only (no auto-trigger, must use `/name`) |
| `user-invocable` | `true` | Set `false` for background knowledge Claude applies automatically |
| `allowed-tools` | all | Comma-separated tool list to restrict access (e.g., `Read, Grep, Glob`) |
| `context` | main | Set `fork` to run in an isolated subagent context |
| `agent` | default | Agent type when forked (e.g., `Explore`) |

### Body

Write in **imperative form** ("Create the file", not "You should create"). Target **1,500–2,000 words**. Move detailed reference material to `references/` if the body exceeds that.

Structure with clear headings:

1. **Title** — `# Skill Display Name` (sentence case)
2. **One-line summary** — what this skill does
3. **Workflow/Steps** — numbered steps Claude follows when the skill triggers
4. **Reference tables** — options, parameters, patterns as needed
5. **Tips** — edge cases, gotchas, common mistakes

### Description Writing

The description determines how Claude matches user intent:

```
This skill should be used when the user asks to "phrase 1", "phrase 2", "phrase 3", or needs help with X.
```

- Include 3-6 trigger phrases in quotes
- End with a general capability clause ("or needs help with...")
- Keep under 200 characters if possible

## Dynamic Context

Inject live data with backtick-wrapped commands:

```markdown
- Current branch: !`git branch --show-current`
- Status: !`git status --short`
```

These execute at skill load time and inject the output inline.

## Arguments

`$ARGUMENTS` captures everything after the slash command:

```
/create-skill api-reviewer  →  $ARGUMENTS = "api-reviewer"
```

## Workflow

1. **Choose placement** — khef built-in (`apps/api/lib/skills/<name>/`), user-level (`~/.claude/skills/<name>/`), or project-level (`<project>/.claude/skills/<name>/`).

2. **Create the directory** and write `SKILL.md` with frontmatter and body following the format above.

3. **Sync if built-in** — for khef built-in skills, run `npm run db:seed:sync` to deploy to `~/.claude/skills/`.

4. **Restart Claude Code** so the new skill loads into context.

5. **Test** by saying one of the trigger phrases in a fresh message.

## Quality Checklist

- [ ] Name is kebab-case and matches directory name
- [ ] Description lists 3-6 trigger phrases in quotes
- [ ] Body is imperative form, under 2,000 words
- [ ] Workflow steps are numbered and actionable
- [ ] No unnecessary optional fields in frontmatter (omit defaults)
- [ ] Only `SKILL.md` created (no empty optional directories)
- [ ] If khef built-in: placed in `apps/api/lib/skills/<name>/` and synced with `npm run db:seed:sync`
