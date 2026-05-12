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

> If `apps/api/.env` doesn't exist yet, do Step 3 first — `db:up` reads `apps/api/.env` for postgres user/port and will fail otherwise.

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
- If `python3` is missing, too old, or you're on **macOS 26 (Tahoe)**, prefer **pyenv** over `brew install python@3.13`. See "Python version steering" below before doing anything else.
- Install Python embedding dependencies: `pip3 install -r apps/api/requirements.txt`
  - If pip refuses with `error: externally-managed-environment` (PEP 668), you are on a Homebrew-managed Python. Create a project venv instead of using `--break-system-packages`:
    ```
    python3 -m venv apps/api/.venv
    apps/api/.venv/bin/pip install -r apps/api/requirements.txt
    ```
    The dev script auto-detects `apps/api/.venv/bin/python` if present.
- The embed server (`embed_server.py`) starts automatically with the API via the vector sync worker
- To manually test the sidecar: `python3 apps/api/embed_server.py` (runs on port 9100)
  - Health check: `curl http://localhost:9100/health`

### Python version steering

The kvec sidecar needs Python 3.10+. How you get there matters — picking the wrong path on macOS 26 (Tahoe) can waste 10+ minutes and still end with a broken Python.

Pick the first matching row:

| Situation | Recommended path |
|---|---|
| `pyenv` is already installed | `pyenv install 3.12 && pyenv local "$(pyenv latest 3.12)"` (inside the repo, installs the latest 3.12.x). Cleanest — pyenv builds from source so it's immune to Homebrew bottle bugs, and the `python3` shim resolves to the pinned version with no symlink hacks. |
| macOS 26 / Tahoe, no pyenv | **Install pyenv first**: `brew install pyenv && pyenv install 3.12 && pyenv local "$(pyenv latest 3.12)"`. Avoid `brew install python@3.13` on Tahoe — the bottle is built against a newer libexpat than macOS 26 ships, so `import pyexpat` fails with `Symbol not found: __XML_SetAllocTrackerActivationThreshold` and pip itself crashes. Python 3.12 via pyenv (built from source) sidesteps this. |
| macOS ≤ 15, no pyenv | `brew install python@3.12` is fine. If `python3` still points to an older version after install, you have a PATH or shim issue — fix that before continuing (do not symlink `/opt/homebrew/bin/python3` by hand). |
| Linux | Use the distro package (`apt install python3.12`) or pyenv. |

Notes:

- Do not run `pip3 install --break-system-packages` against Homebrew's Python. The PEP 668 guard exists for a reason; bypassing it leaves stray packages in the brew prefix that break on the next `brew upgrade`. Use a venv instead.
- `npm run python:setup` runs the same logic as Step 4 with graceful fallbacks; running it again after fixing Python is the easiest verification.

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

### Codex CLI setup

For a fresh Codex machine, run:

```bash
npm run codex:setup
```

This script:

- builds `apps/api/mcp-server/build/index.js`
- creates `~/.codex/config.toml` with a `khef` MCP entry if missing
- creates `~/.codex/AGENTS.md` if missing

Why `~/.codex/AGENTS.md` matters: the Khef UI only lists assistants that have at least one discovered global config file. On a clean machine, Codex often has neither `~/.codex/config.toml` nor `~/.codex/AGENTS.md`, so it does not appear in the Assistants page until one of those files exists.

The generated MCP entry points to:

```toml
[mcp_servers.khef]
command = "node"
args = ["<project-root>/apps/api/mcp-server/build/index.js"]
startup_timeout_sec = 15
tool_timeout_sec = 60

[mcp_servers.khef.env]
KHEF_API_URL = "http://localhost:3201"
```

After running the script:

- restart Codex so it reloads `~/.codex/config.toml`
- restart the khef API or trigger assistant config discovery in the UI
- verify `/mcp` in Codex shows the `khef` server

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
