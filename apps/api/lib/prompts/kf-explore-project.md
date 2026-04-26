# Explore Project

Discover and document operational knowledge about a project. Scan configs, scripts, schemas, and structure to build a knowledge base that persists across sessions and prevents re-exploration.

## When to Use

- First time working with a project
- Project has changed significantly (new scripts, DB changes, restructure)
- Knowledge from `/refresh_project_knowledge` seems stale or incomplete

## Instructions

### 1. Ensure Project Exists

Before anything else, verify the khef project exists. If `get_project_knowledge` or `initialize_session` returns a "not found" error, create the project with its **path** set to the current working directory:

```
create_project(
  name: "<project-name>",
  description: "Brief description of what the project is",
  path: "/absolute/path/to/project/root"
)
```

The `path` should be the project's root directory on disk (e.g., the directory containing `package.json`, `Cargo.toml`, etc.). This enables session tracking, source code indexing, and file-based features.

### 2. Load Existing Knowledge

Check what's already documented:

```
get_project_knowledge(project_handle: "<project>")
```

This returns any previously stored commands, context, and patterns. Use this as your baseline - you'll compare against it and update what's changed. If something is already documented, avoid re-exploring it unless it has changed.

### 3. Search Khef for Code Context

Before exploring the filesystem directly, use `unified_search` to query all khef backends in parallel. Then use individual tools for targeted follow-ups.

**Broad discovery** — searches memories, source code, commits, sessions, docs, and slack in one call:

```
unified_search(q="project structure entry point", project="<project>")
unified_search(q="database schema migration", project="<project>")
```

**Targeted follow-ups** — when you need specific filters:

```
search_memories(q="route handler", project_handle="<project>", type="pattern")
search_sessions(q="project setup", session_id="<specific-session>")
```

**Tips:**
- Use `unified_search` *before* using `ls`, `find`, `cat`, or other filesystem tools
- `unified_search` handles verbose queries via auto-splitting — no need to manually shorten
- Use `backends` param to skip slow backends (e.g., `backends="memories,sessions,commits"`)
- Use individual tools only when you need type/tag/status/session_id/language filters

### 4. Identify Project Type

Understand what kind of project this is:

```
# Check root directory for indicators
ls -la
# Look for: package.json, Cargo.toml, go.mod, pyproject.toml, Makefile, docker-compose.yml, etc.
```

### 5. Discover Commands

Find runnable commands based on project type:

| Indicator | Where to Look |
|-----------|---------------|
| `package.json` | `scripts` section |
| `Makefile` / `justfile` | Make/just targets |
| `docker-compose.yml` | Service commands |
| `scripts/` directory | Shell scripts, Node scripts |
| `.github/workflows/` | CI commands |
| `pyproject.toml` | Poetry/PDM scripts |

**Compare with existing knowledge and update if changed:**
```
set_project_commands(
  project_handle: "<project>",
  content: "## Development\n\n- `npm run dev` - Start dev server (port 3100, hot reload)\n- `npm run build` - Build for production\n\n## Database\n\n- `npm run db:up` - Start dev database\n- `npm run db:migrate` - Run migrations\n- `npm run db:seed` - Seed test data\n\n## Testing\n\n- `npm test` - Run tests (watch mode)\n- `npm run test:db:up` - Start test database\n\n## Other\n\n- `npm run lint` - Run linter\n- `npm run typecheck` - Check types"
)
```

### 6. Discover Database Info

**Always check for database usage** - look for these indicators:
- `.env` or config with `DATABASE_URL`, `DB_HOST`, connection strings
- `docker-compose.yml` with postgres, mysql, mongo services
- Migration directories (`db/migrate/`, `migrations/`, `prisma/`)
- ORM config files (`prisma/schema.prisma`, `drizzle.config.ts`, `knexfile.js`)

**How to discover schema:**

| Method | Command/Location |
|--------|------------------|
| Migration files | Read `db/migrate/migrations/*.sql` or equivalent |
| Prisma | Read `prisma/schema.prisma` |
| Running DB | `psql -c "\dt"` or check docker logs |
| TypeORM/Drizzle | Check entity/schema files in `src/` |

**What to document:**
- Database type and port (e.g., PostgreSQL on 5432)
- Key tables and their purpose
- Important relationships (foreign keys)
- Any views or custom functions

**Store or update as context** (even if exists - schemas change):
```
set_project_context(
  project_handle: "<project>",
  handle: "db-schema",
  title: "Database schema overview",
  content: "PostgreSQL on port 5432...\n\nKey tables:\n- users - User accounts\n- projects - Project containers\n- memories - Core memory storage\n..."
)
```

### 7. Discover Project Structure

Document important paths and their purposes:

- Source code entry points
- Config file locations
- Log directories
- Test directories
- Build output locations

```
set_project_context(
  project_handle: "<project>",
  handle: "project-structure",
  title: "Project structure",
  content: "## Key Directories\n\n- `src/` - Source code\n- `src/routes/` - API endpoints\n- `logs/` - Application logs\n..."
)
```

### 8. Examine Commit History and Contributors

Analyze the project's git log to understand conventions and team composition.

**Commit message conventions:**

```bash
# Sample recent commits to identify patterns
git log --oneline -30
# Look for prefixes (feat:, fix:, chore:), scope tags, ticket refs, etc.
git log --format="%s" -50 | head -50
```

Based on observed patterns, create an assistant-rule memory documenting the project's commit convention:

```
create_memory(
  project_id: "<project>",
  handle: "commit-conventions",
  title: "Commit message conventions",
  type: "assistant-rule",
  tags: ["git", "conventions"],
  content: "# Commit Message Convention\n\n## Format\n- <describe observed format>\n- <prefix/scope style if any>\n- <ticket reference pattern if any>\n\n## Examples\n- `feat(auth): add OAuth2 flow (#123)`\n- `fix: resolve null pointer in checkout`\n\n## Notes\n- <any project-specific rules observed>"
)
```

**Contributors:**

```bash
# List all contributors with commit counts
git shortlog -sne --all
```

Store contributors in project knowledge:

```
set_project_context(
  project_handle: "<project>",
  handle: "contributors",
  title: "Project contributors",
  content: "## Contributors\n\n| Author | Commits | Email |\n|--------|---------|-------|\n| Jane Doe | 342 | jane@example.com |\n| ..."
)
```

### 9. Research Project History via Connected Services

If MCP connectors for external services are available, use them to gather additional project context. Check which connectors are accessible and query relevant ones.

**Slack** (if `search_slack` / `ingest_slack` tools are available):
- Search for project-related channels and discussions
- Look for design decisions, incident discussions, onboarding threads
- `search_slack(q="<project-name> architecture")`, `search_slack(q="<project-name> deploy")`

**Glean** (if Glean MCP tools are available):
- Search for internal documentation, wikis, and design docs about the project
- Look for onboarding guides, architecture overviews, and runbooks

**Atlassian** (if Jira/Confluence MCP tools are available):
- Search Jira for the project's board, epics, and recent sprints
- Search Confluence for design docs, ADRs, and retrospectives
- Look for deployment runbooks and incident postmortems

Store any significant findings as context or reference memories:

```
set_project_context(
  project_handle: "<project>",
  handle: "external-docs",
  title: "External documentation and resources",
  content: "## Slack Channels\n- #project-name - Main dev channel\n- #project-name-incidents - Incident response\n\n## Confluence\n- Architecture Overview: <link>\n- Deployment Runbook: <link>\n\n## Jira\n- Board: <link>\n- Current sprint: ..."
)
```

**Tip:** Not all connectors will be available in every environment. Check tool availability first and skip gracefully if a connector isn't present.

### 10. Discover Environment Setup

- Required environment variables
- Dependencies and how to install
- Local vs CI differences
- Test environment differences (e.g., test DB, mocks, feature flags)

### 11. Document Workflows (Be Explicit)

If you discover common multi-step workflows, store as patterns. These are the most important items to prevent assistants from re-exploring each session. Capture *exact steps*, prerequisites, and where to look for failures.

```
set_project_pattern(
  project_handle: "<project>",
  handle: "testing-workflow",
  title: "Running tests workflow",
  content: "1. Ensure test DB is up: `npm run test:db:up`\n2. Run tests: `npm test`\n3. For specific file: `npm test -- path/to/test.ts`"
)

set_project_pattern(
  project_handle: "<project>",
  handle: "testing-strategy",
  title: "Testing strategy",
  content: "- Unit tests: run with `npm run test:unit` (fast, no DB)\n- Integration tests: run with `npm run test:integration` (requires test DB)\n- CI: runs `npm run test` and `npm run lint`\n- Common failures: see `tests/setup.ts` and `tests/global-setup.ts`"
)
```

## What to Capture

### Required (always create or verify not applicable)

These must be created for every project. If one doesn't apply, explicitly note why.

| Item | Handle | What to Document |
|------|--------|------------------|
| **Commands** | `project-commands` | All runnable scripts grouped by category (dev, test, db, deploy) |
| **DB Schema** | `db-schema` | Database type, tables, relationships. If no DB, note "No database" |
| **Project Structure** | `project-structure` | Key directories, entry points, config locations |

### Strongly Recommended (to avoid re-exploration)

These should be captured for most projects. If not applicable, explicitly note why.

| Item | Handle | What to Document |
|------|--------|------------------|
| **Commit Conventions** | `commit-conventions` | Observed commit message format, prefixes, scope tags, ticket refs (assistant-rule) |
| **Contributors** | `contributors` | All contributors with commit counts and emails (context) |
| **Testing Workflow** | `testing-workflow` | Exact steps to run tests locally, including prerequisites (DB, services, env vars) |
| **Testing Strategy** | `testing-strategy` | What’s covered by unit vs integration vs e2e, where tests live, and how CI runs them |

### Recommended (create if discovered)

**Context** - store via `set_project_context`:
- `log-locations` - Log file locations and how to tail them
- `env-setup` - Environment variables and their purpose
- `api-endpoints` - API endpoints summary
- `docker-services` - Container names, ports, connection strings

**Patterns** - store via `set_project_pattern`:
- `testing-workflow` - How to run the full test suite
- `testing-strategy` - Unit vs integration vs e2e coverage and CI flow
- `local-setup` - How to set up local development
- `debugging` - How to debug common issues
- `deployment` - How to deploy changes

**External sources** (if MCP connectors available):
- `external-docs` - Links to Slack channels, Confluence pages, Jira boards, Glean results

## After Exploration

1. **Verify required items exist and are up to date:**
   - `project-commands` - Created or updated?
   - `db-schema` - Created, or noted "No database"?
   - `project-structure` - Created or updated?
2. **Verify strongly recommended items:**
   - `commit-conventions` - Assistant-rule created from observed git log patterns?
   - `contributors` - Context created with contributor list?
   - `testing-workflow` - Created or updated?
   - `testing-strategy` - Created or updated?
3. **Check external sources** (if connectors available):
   - Searched Slack, Glean, Atlassian for project history?
   - `external-docs` context created if findings were relevant?
4. Verify commands work by running a few key ones
5. **Sync knowledge and rules to disk** so future sessions pick up the new knowledge immediately:
   ```
   seed_and_sync(project_handle: "<project>")
   ```
   This syncs rules and project knowledge to `KF-RULES.md` and `KF-PROJECT-KNOWLEDGE.md` files that Claude Code loads at session start.
6. Report what was added/updated to the user

## Tips

- **Compare before updating** - Don't blindly overwrite; check existing knowledge first
- Be thorough but not exhaustive - focus on frequently-used commands
- Include actual command strings, not just descriptions
- Note any gotchas or prerequisites for commands
- If a command requires specific env vars or setup, document that
