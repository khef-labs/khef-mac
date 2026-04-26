# Khef Setup

Instructions for Claude to bootstrap and verify the khef project.
When the user says "run khef", follow these steps in order.

## Step 1: Prerequisites

- Verify Docker is installed and running: `docker info`
- Verify Node.js version matches `.nvmrc` (24.13.0): `node --version`
  - If wrong version: try `source ~/.nvm/nvm.sh && nvm use` (reads `.nvmrc`)
  - If nvm not available or fails: proceed if node is 24.x, warn user otherwise
- Verify npm version is 11+: `npm --version`
  - If below 11: `npm install -g npm@latest` (avoids lockfile format diffs across machines)
- Check if npm dependencies are installed: if `node_modules/` is missing or stale, run `npm install && npm run install:all`
- Install Playwright Chromium (needed for Kroki diagram rendering and UI tests): `npx playwright install chromium`

## Step 2: Database

- Check for existing khef containers: `docker ps -a --filter name=khef`
  - If postgres container is running and healthy → skip to Step 3
  - If stopped → `docker start khef khef-kroki khef-kroki-mermaid`, wait for healthy
  - If not found → `npm run db:up`, wait for healthy
- Run migrations: `npm run db:migrate`
- Run seeds: `npm run db:seed`

## Step 3: Environment files

- Check if `apps/api/.env` exists
  - If not, copy from `apps/api/.env.example`
- Check if `apps/ui/.env` exists
  - If not, copy from `apps/ui/.env.example`
- Read port values from env files:
  - `PORT` from `apps/api/.env` (API server, default 3201)
  - `POSTGRES_PORT` from `apps/api/.env` (database, default 5533)
  - `KROKI_PORT` from `apps/api/.env` (diagram service, default 8101)
  - `KHEF_UI_PORT` from `apps/ui/.env` (UI dev server, default 5174)
  - `KHEF_PROXY_PORT` from `apps/ui/.env` (API proxy, default 5175)
- Check for port conflicts: `lsof -i :$PORT`, `lsof -i :$POSTGRES_PORT`, `lsof -i :$KROKI_PORT`, `lsof -i :$KHEF_UI_PORT`, `lsof -i :$KHEF_PROXY_PORT`
  - If conflicts found: identify what's using the port, warn user, suggest alternative

## Step 4: Vector Search (kvec)

kvec uses pgvector (already in the PostgreSQL container) and a Python sidecar for embeddings. No external vector DB needed.

- Verify Python 3.10+: `python3 --version`
- Install Python embedding dependencies: `pip3 install -r apps/api/requirements.txt`
- The embed server (`embed_server.py`) starts automatically with the API via the vector sync worker
- To manually test the sidecar: `python3 apps/api/embed_server.py` (runs on port 9100)
  - Health check: `curl http://localhost:9100/health`

## Step 5: Build and configure MCP server

- Build: `npm run mcp:build`
- Check if `~/.claude.json` has a `khef` entry under `mcpServers`
  - If missing, add it using the project path and `$PORT` from Step 3:
    ```json
    {
      "mcpServers": {
        "khef": {
          "type": "stdio",
          "command": "node",
          "args": ["<project-root>/apps/api/mcp-server/build/index.js"],
          "env": {
            "KHEF_API_URL": "http://localhost:$PORT",
            "KHEF_DATABASE_URL": "postgresql://postgres@localhost:$POSTGRES_PORT/khef"
          }
        }
      }
    }
    ```
  - `<project-root>` is the absolute path to the khef repo
  - `$PORT` is the API port from `apps/api/.env`
  - `$POSTGRES_PORT` is the database port from `apps/api/.env`
  - If entry exists, verify the `args` path, `KHEF_API_URL` port, and `KHEF_DATABASE_URL` port match
- If MCP config was added or changed: tell user to restart Claude Code, then re-run setup to continue from Step 6

## Step 6: Start and verify API server

- Start API: `npm run dev:api`
- Wait for health check: retry `curl -sf http://localhost:$PORT/health` up to 10 times with 2s delay
- If healthy: report success
- If not: check logs, port conflicts, DB connection

## Step 7: Start and verify the UI 

- Start UI: `npm run dev:ui`
- Wait for UI to be available: retry `curl -sf http://localhost:$KHEF_UI_PORT` up to 10 times with 2s delay
- If healthy: report success and open dashboard URL
- If not: check logs, port conflicts, API connection
- Kill the background processes after verification

## Step 8: Advise user

Tell the user to run in separate terminals:
- Terminal 1: `npm run dev:api` (API server)
- Terminal 2: `npm run dev:ui` (UI server)

