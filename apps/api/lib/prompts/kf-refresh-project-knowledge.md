# Refresh Project Knowledge

Load operational knowledge from previous explorations to get up to speed quickly on a known project.

## When to Use

- Starting a new session on a project you've explored before
- After `initialize_session` when you need deeper operational context
- When you're about to run commands but want to check what's already documented

## Instructions

**IMPORTANT:**
- Use `get_project_knowledge` directly - this is a dedicated tool for loading project knowledge.

```
get_project_knowledge(project_handle: "my-project")
```

The tool accepts the project handle directly.

This single call returns everything in one request:
- `commands` - All project commands (dev, test, db, deploy, etc.)
- `context[]` - Architecture, DB schema, log locations, env setup
- `patterns[]` - Workflows and "how to" guides

## After Loading

**Check for required items:**
- `commands` exists? If null, run `/explore_project`
- `context[]` includes `db-schema`? If missing and project has a DB, run `/explore_project`
- `context[]` includes `project-structure`? If missing, run `/explore_project`

**Then:**
- Reference these when running commands (don't re-discover what's documented)
- If you find new commands or info changes, use `set_project_commands` or `set_project_context` to update
- If knowledge seems stale or incomplete, run `/explore_project` to refresh

## Tips

- Commands should include the actual command string, not just descriptions
- If a command fails, check if the knowledge needs updating
- Cross-reference with `initialize_session` todos for current work context
