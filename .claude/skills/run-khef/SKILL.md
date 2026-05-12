---
name: run-khef
description: This skill should be used when the user says "run khef" on a fresh clone of khef-mac (or asks to "bootstrap khef", "set up khef", "start khef for the first time", "first-time setup khef"). Walks SETUP.md step by step — prerequisites (Docker, Node, ports), JS + Python deps, database (containers, migrations, seeds), MCP server registration, then brings up the API and UI with health checks. Do NOT run `npm run dev:api`, `npm run dev:ui`, or any other dev command directly until SETUP.md is complete.
---

# Run khef (first-time setup)

The user wants to bootstrap khef from a fresh clone. `SETUP.md` at the repo root is the source of truth — read it and follow it step-by-step.

## Step 0: Pre-flight — abort if khef is already set up

Run these checks BEFORE touching SETUP.md. If any of them indicates khef is already installed, **stop and ask the user what they want** instead of re-running setup. Re-running a completed setup can spin up duplicate containers, overwrite env files, or restart the MCP server unnecessarily.

Checks (run in order; stop at the first hit):

1. **API healthy?**
   ```bash
   curl -s -o /dev/null -w "%{http_code}" http://localhost:3201/health
   ```
   If this returns `200` → khef is already fully up. Report: "Khef is already running at http://localhost:3201 (and UI at http://localhost:5174). What would you like to do — restart, open the UI, or something else?" Then stop. Do NOT proceed with SETUP.md.

2. **Database container running?**
   ```bash
   docker ps --filter name=khef --filter status=running --format '{{.Names}}'
   ```
   If output includes `khef` → DB is up but the API is not. Report: "The khef database is running but the API isn't. Want me to start it (`npm run dev:api`) or run through full setup anyway?" Then stop. Do NOT proceed with SETUP.md without confirmation.

3. **Database container stopped (not missing)?**
   ```bash
   docker ps -a --filter name=khef --format '{{.Names}} {{.Status}}'
   ```
   If a stopped `khef` container exists → setup ran previously. Report: "Found a stopped khef container. Want me to start it (`docker start khef ...`) or wipe and rebuild from scratch?" Then stop. Do NOT proceed with SETUP.md without confirmation.

4. **MCP server already registered?**
   ```bash
   jq -e '.mcpServers.khef' ~/.claude.json >/dev/null 2>&1 && echo "registered"
   ```
   If output is `registered` AND none of checks 1–3 fired → unusual state (MCP entry exists but no containers). Report this to the user before running setup, in case they manually cleared the DB but kept the MCP config.

Only if all four checks indicate a truly fresh state (no API, no running container, no stopped container, no MCP entry) — proceed to the workflow below.

## Hard rules

- Do NOT run `npm run dev:api`, `npm run dev:ui`, or any other dev/server command until SETUP.md's earlier steps have completed successfully. The dev commands assume Docker is up, the database has migrations + seeds, env files exist, ports are free, deps are installed, and the MCP server is registered — none of which a fresh clone has.
- Do NOT skip steps, even if some look already satisfied. Each step has a check; let the check decide whether to act.
- Do NOT improvise alternatives if a check fails (missing tool, wrong Node version, port in use, etc.). Surface the problem to the user and stop. The user fixes the environment; you continue.

## Workflow

1. Open `SETUP.md` from the repo root.
2. Execute each numbered step in order. Verify the check, then run the action only if the check fails.
3. After each step, briefly tell the user what you did (or skipped) and what's next.
4. When SETUP.md finishes, surface the API and UI URLs plus the most recent health-check output so the user can confirm everything is up.

## When this skill does NOT apply

- The user said something like "run khef tests", "run khef refresh", "run khef <something else>". Those are not first-time-setup phrases; treat them literally and look up the matching script.
- The repo is khef-labs/khef (the source repo), not khef-mac. The source repo has its own dev cadence and the contributor already knows the layout — confirm with the user before running through SETUP.md from scratch there.
