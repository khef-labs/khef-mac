---
config_path: ~/.claude/settings.json
---

# Claude Code Settings

Global settings for Claude Code, including hooks, permissions, and MCP server configuration.

## Structure

```json
{
  "permissions": { ... },
  "hooks": { "PreToolUse": [...], "PostToolUse": [...] },
  "mcpServers": { ... }
}
```

## Hooks

Hooks are shell commands that run in response to tool use events. They enforce behavioral guardrails and project conventions.

### Hook Types

| Event | When | Use For |
|-------|------|---------|
| `PreToolUse` | Before a tool executes | Gates, confirmations, deny-with-feedback |
| `PostToolUse` | After a tool executes | Logging, side effects |

### Hook Matcher

Each hook has a `matcher` that determines which tools it applies to:

- `tool_name` — exact tool name (e.g., `Read`, `Grep`, `Bash`)
- `tool_input.*` — match on input fields

### Permission Decisions

| Decision | Effect |
|----------|--------|
| `allow` | Tool proceeds normally |
| `deny` | Tool blocked; `permissionDecisionReason` fed back to Claude |
| `ask` | User prompted; `permissionDecisionReason` shown to user only |

**Key insight:** Use `deny` to influence Claude's behavior (reason is fed back). Use `ask` for user confirmation gates (reason shown to user, not Claude).

### Marker Pattern

Khef hooks use a deny-once-then-allow pattern with file markers in `/tmp/khef-hooks/`:

1. First call: denied with feedback message
2. Subsequent calls: allowed (marker file exists)
3. Markers auto-expire (15 min for search gates, session-scoped for read gates)

## MCP Servers

The `mcpServers` section configures external tool providers:

```json
{
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "node",
      "args": ["path/to/server.js"],
      "env": { "KEY": "value" }
    }
  }
}
```

## Permissions

Controls which tools Claude can use without asking:

```json
{
  "permissions": {
    "allow": ["Read", "Glob", "Grep"],
    "deny": []
  }
}
```
