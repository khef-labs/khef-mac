---
name: manage-hooks
description: This skill should be used when the user asks to "add a hook", "create a hook", "manage hooks", "update a hook", "new PreToolUse hook", or needs to create, edit, or install Claude Code hooks in the khef system.
---

# Manage Hooks

Create, edit, and install Claude Code PreToolUse hooks using the khef hooks system.

## Source of Truth

All hooks live in `lib/utils/hooks/hooks.reference.json`. Never edit `~/.claude/settings.json` directly for hooks — always edit the reference file and install.

## Key Files

| File | Role |
|------|------|
| `lib/utils/hooks/hooks.reference.json` | Source of truth for all hooks |
| `lib/utils/hooks/install-hooks.js` | Merges reference into `~/.claude/settings.json` |

## Hook Types

### `ask` — User Confirmation Gate

Prompts the user to approve or deny. The `permissionDecisionReason` is shown to the user but **not** fed back to Claude.

Use for: dangerous operations where the user should decide (e.g., running kdag jobs, raw JSON access).

```json
{
  "matcher": "mcp__khef__run_kdag_job",
  "hooks": [{
    "type": "command",
    "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"Reason shown to user.\"}}'"
  }]
}
```

### `deny` — Model Behavior Gate

Blocks the tool call. The `permissionDecisionReason` **is** fed back to Claude, allowing it to adjust behavior.

Use for: enforcing workflows where Claude should try something else first.

```json
{
  "matcher": "Grep",
  "hooks": [{
    "type": "command",
    "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"Reason fed back to Claude.\"}}'"
  }]
}
```

## Deny-Once-Then-Allow Pattern

The most common pattern: deny the first call to remind Claude, then allow subsequent calls. Uses temp marker files scoped to the session.

### With Time-Based Expiry (15 min)

Re-fires the denial if the marker is older than 15 minutes (900 seconds). Good for long sessions that switch topics.

```
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name')
MARKER=/tmp/khef-hooks/$PPID-$TOOL
STALE=0
if [ -f "$MARKER" ]; then
  AGE=$(( $(date +%s) - $(stat -f %m "$MARKER") ))
  [ $AGE -gt 900 ] && STALE=1
fi
if [ ! -f "$MARKER" ] || [ $STALE -eq 1 ]; then
  mkdir -p /tmp/khef-hooks && find /tmp/khef-hooks -type f -mtime +1 -delete 2>/dev/null
  touch "$MARKER"
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Your reason here."}}'
else
  touch "$MARKER"
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
fi
```

### Without Expiry (Permanent Per-Session)

Denies once, allows for the rest of the session. Good for one-time reminders.

```
MARKER=/tmp/khef-hooks/$PPID-my-hook
if [ ! -f "$MARKER" ]; then
  mkdir -p /tmp/khef-hooks && touch "$MARKER"
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Your reason here."}}'
else
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
fi
```

## Content-Based Matching (Bash Commands)

When the matcher is `Bash`, inspect `tool_input.command` to fire only for specific commands. Pass through silently for non-matching commands (output nothing = allow).

```
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
if echo "$CMD" | grep -q 'git commit'; then
  # ... deny/allow logic here
fi
# No output = allow for non-matching commands
```

## Per-File Matching (Read)

Extract the file path and use it in the marker name for per-file tracking.

```
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path')
SAFE=$(echo "$FILE" | tr '/' '_')
MARKER=/tmp/khef-hooks/$PPID-Read-$SAFE
```

## Marker System

- **Location**: `/tmp/khef-hooks/`
- **Naming**: `$PPID-<identifier>` (scoped to Claude Code process)
- **Cleanup**: `find /tmp/khef-hooks -type f -mtime +1 -delete` prunes files older than 24 hours
- **Cleanup trigger**: runs when creating a new marker (not on every call)
- macOS `/tmp` (`/private/tmp`) is not cleared on reboot, so cleanup is necessary

## Workflow: Adding a New Hook

1. Read `lib/utils/hooks/hooks.reference.json`
2. Add the new hook entry under `hooks.PreToolUse`
3. Choose the pattern:
   - Simple `ask` or `deny` for static gates
   - Deny-once-then-allow for behavioral reminders
   - Content-based matching for Bash command inspection
   - Per-file matching for Read gates
4. Install: `node lib/utils/hooks/install-hooks.js`
5. Restart Claude Code for the new hook to take effect
6. Update the context memory (`ctx-claude-code-hooks`) and README

## Matcher Reference

The `matcher` field is a regex matched against tool names:

| Matcher | Matches |
|---------|---------|
| `Grep` | Grep tool only |
| `Search\|Glob\|Grep\|Explore` | Any of the four tools |
| `Read` | Read tool only |
| `Bash` | Bash tool (use content-based matching to filter commands) |
| `mcp__khef__run_kdag_job` | Specific MCP tool |

## JSON Escaping

Hook commands are JSON strings inside JSON. Escape quotes carefully:

- `\"` for quotes inside the command string
- `'{...}'` for the JSON output (single-quoted to avoid double-escaping)
- Keep commands on one line in the reference file

## Install and Test

```bash
# Install hooks from reference
node lib/utils/hooks/install-hooks.js

# Restart Claude Code, then test by triggering the matched tool
```
