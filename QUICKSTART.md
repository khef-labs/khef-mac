# Quickstart

Get Khef running locally on macOS in under 5 minutes.

Khef is built for macOS. Native features (Swift voice panel, iTerm2 session badging, AppleScript live messaging) won't work on Windows or Linux. See the [README](README.md#requirements) for the full requirements list.

> **Using Claude Code?** Just say "run khef" and Claude will bootstrap everything automatically via `SETUP.md`.

## Prerequisites

- macOS 14 (Sonoma) or later
- [Node.js](https://nodejs.org/) v24+ (see `.nvmrc`)
- [Docker Desktop](https://www.docker.com/) (for PostgreSQL and Kroki)
- [Git](https://git-scm.com/)
- Xcode Command Line Tools (`xcode-select --install`) — needed for the Swift voice app
- [iTerm2](https://iterm2.com/) (recommended) — live agent messaging and session badging rely on it

## 1. Clone and install

```bash
git clone https://github.com/khef-labs/khef-mac.git
cd khef-mac

# Install dependencies for both apps
npm --prefix apps/api install
npm --prefix apps/ui install

# Build the MCP server
npm --prefix apps/api/mcp-server install
npm --prefix apps/api/mcp-server run build
```

## 2. Configure environment

```bash
# API
cp apps/api/.env.example apps/api/.env

# UI
cp apps/ui/.env.example apps/ui/.env
```

The defaults work out of the box. No secrets required for local development.

## 3. Start the database

```bash
npm run db:up
```

This starts a PostgreSQL 17 container (with pgvector) on port 5533 and a Kroki diagram rendering service on port 8101.

Wait a few seconds for the health check, then run migrations and seed data:

```bash
npm run db:migrate
npm run db:seed
```

## 4. Start the API

```bash
npm run dev:api
```

The API server starts on **http://localhost:3201**. Verify with:

```bash
curl http://localhost:3201/health
```

## 5. Start the UI

In a separate terminal:

```bash
npm run dev:ui
```

The UI opens on **http://localhost:5174**. It proxies API requests through a local proxy on port 5175.

## 6. Open Khef

Visit **http://localhost:5174** in your browser. You should see the splash screen, then the main interface with seeded demo data.

## What you get

| Component | URL | Purpose |
|-----------|-----|---------|
| API | http://localhost:3201 | REST API for memories, projects, tags, relations |
| UI | http://localhost:5174 | Web interface for browsing and managing memories |
| PostgreSQL | localhost:5533 | Database (connect with `psql $DATABASE_URL`) |
| Kroki | http://localhost:8101 | Diagram rendering (mermaid, d2, plantuml, graphviz) |

## Using with Claude Code (MCP)

Khef includes an MCP server that gives Claude Code direct access to your project memories.

Add to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "khef": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/Users/<user>/projects/khef-mac/apps/api/mcp-server/build/index.js"
      ],
      "env": {
        "KHEF_API_URL": "http://localhost:3201"
      }
    }
  }
}
```

Restart Claude Code, then use `/mcp` to verify the connection. You should see 140+ tools for memory management and pipeline orchestration.

## Using with Codex CLI (MCP)

Run:

```bash
npm run codex:setup
```

That bootstrap script creates the two files Khef expects for Codex discovery on a new machine:

- `~/.codex/config.toml`
- `~/.codex/AGENTS.md`

It also adds the khef MCP server using this build output:

```toml
[mcp_servers.khef]
command = "node"
args = ["/absolute/path/to/khef/apps/api/mcp-server/build/index.js"]

[mcp_servers.khef.env]
KHEF_API_URL = "http://localhost:3201"
```

Important: the Khef UI only lists assistants that have at least one discovered global config file. If Codex is installed but `~/.codex/config.toml` and `~/.codex/AGENTS.md` do not exist yet, Codex will not appear in the Assistants page.

After setup:

1. Restart Codex.
2. Restart the khef API or trigger config discovery from the Codex assistant page.
3. Run `/mcp` in Codex and confirm the `khef` server is present.

## Optional: Google Cloud integrations

Both features use the `gcloud` CLI. Install it first if you haven't:

```bash
brew install --cask google-cloud-sdk
```

**Google Docs** (import and sync):
```bash
gcloud auth login <email> --enable-gdrive-access
```

**Gemini Chat** (Vertex AI):
```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project <your-gcp-project>
gcloud services enable aiplatform.googleapis.com --project=<your-gcp-project>
```

Then set your GCP project in the UI under Settings > Gemini.

## Optional: Vector search

Semantic similarity search across memories, source code, commits, and sessions. Built-in — no external services needed. Backed by `pgvector` in the same Postgres instance and a Python embed sidecar (sentence-transformers, all-mpnet-base-v2, 768 dims) that starts automatically with the API.

Add to `apps/api/.env`:

```
VECTOR_ENABLED=true
```

Then `npm run dev:api` will spawn the embed sidecar on `http://127.0.0.1:9100`. The background worker auto-syncs embeddings as memories change.

## Common tasks

```bash
# Stop the database
npm run db:down

# Run API tests
npm run test:db:up    # start test database first
npm run test

# Run UI tests (requires API running)
npm run test:ui

# Rebuild MCP server after changes
npm run mcp:build
```

## Project structure

```
khef-mac/
  apps/
    api/        Fastify API, database, MCP server
    ui/         Preact SPA
    voice/      Swift menu-bar voice control panel (macOS native)
  docker-compose.yml
  package.json  Root scripts
```

See `apps/api/docs/api/openapi.yaml` for the OpenAPI spec.
