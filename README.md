# KHEF

## Shared Knowledge and Purpose

Khef is a project memory and knowledge platform. It captures development decisions, context, and patterns and surfaces them through AI assistants in iTerm2 and Claude Code sessions.

Khef is built for macOS by design. Native features include a Swift voice-control panel (Carbon hotkeys, on-device `SFSpeechRecognizer`), iTerm2 session badging via AppleScript, and live agent-to-agent messaging that targets specific iTerm2 tabs. Windows support is not planned for v1.

## Requirements

- macOS 14 (Sonoma) or later
- Node.js 24+ (see `.nvmrc`)
- Docker Desktop (for the Postgres + Kroki sidecars)
- Xcode Command Line Tools (Swift toolchain — needed for the voice app)
- iTerm2 (recommended — live messaging and session badging rely on it)

## Quick Start

### First-time setup

```bash
npm run setup
```

This copies `.env.example` files, installs all dependencies, starts the database, runs migrations, and seeds data.

### Development

Run the API and UI in separate terminals:

```bash
npm run dev:api   # API on port 3201
npm run dev:ui    # UI on port 5174
```

### After pulling changes

```bash
npm run refresh
```

Runs migrations, installs dependencies, and reseeds.

For detailed command breakdowns, see [CLAUDE.md](CLAUDE.md) or the project commands memory in khef (`project-commands` handle).

Install behavioral guardrails for Claude Code sessions:

```bash
npm run hooks:install
```

This merges hooks from `lib/utils/hooks/hooks.reference.json` into `~/.claude/settings.json`, preserving other settings.

## MCP Server

Build the MCP server for Claude Code integration:

```bash
npm run mcp:build
```

Configure in `~/.claude.json` under `mcpServers.khef`. See `CLAUDE.md` for troubleshooting.


## API Documentation

View and test the API interactively with Swagger UI:

```bash
npm run docs:preview
```

Opens at http://localhost:8080/docs/api/swagger.html.

Other doc commands:

```bash
npm run docs:build   # Build static HTML documentation
npm run docs:lint    # Lint OpenAPI spec
```

## Testing

```bash
npm run test:db:up   # Start test database (port 5433, ephemeral)
npm run test         # Run all tests (watch mode)
npm run test:db:down # Stop test database
```

Tests run sequentially against real PostgreSQL. See `CLAUDE.md` for full command reference.

---

> **Disclaimer**: This is a personal project under active development. No warranty is provided, express or implied.
>
> **License**: Copyright (c) 2026 Roger Garza. All rights reserved. See [LICENSE](LICENSE).
