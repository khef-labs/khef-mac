---
name: slack-sync
description: This skill should be used when the user asks to "sync slack", "register a slack channel", "export slack messages", "ingest slack", "search slack", or needs to set up or run the Slack export pipeline.
---

# Slack Sync

Register Slack channels, run export-split-ingest pipelines via kdag, and search ingested messages.

## Overview

The Slack sync system tracks registered channels in a `slack_channels` table and orchestrates export via a 3-step kdag pipeline: **export** (Playwright browser automation) → **split** (monthly file splitting) → **ingest** (kvec vector indexing). Subsequent syncs are incremental using `last_message_ts`.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `register_slack_channel` | Register a channel for tracked sync |
| `list_registered_slack_channels` | List all registered channels with export state |
| `sync_slack_channel` | Trigger the full export→split→ingest pipeline |
| `search_slack` | Search ingested messages (semantic or keyword) |
| `list_slack_channels` | List ingested slack documents in kvec |
| `ingest_slack_dir` | Manually ingest a directory of markdown files |

## Registering a Channel

Gather these details from the user:

| Field | Required | Example | Notes |
|-------|----------|---------|-------|
| `channel_id` | Yes | `D03FA9ZJ9GC` | From Slack URL: `app.slack.com/client/{workspace_id}/{channel_id}` |
| `workspace_id` | Yes | `T03C0ENJ6UE` | From Slack URL |
| `channel_name` | Yes | `roger-garza` | Display name for the channel |
| `workspace_name` | No | `railsconf2022` | Human-readable workspace name |
| `channel_type` | No | `dm` | `dm`, `channel`, `group` (default: `dm`) |
| `export_path` | No | `slack/my-channel` | Overrides global default directory |

Register with:

```
register_slack_channel(
  channel_id: "D03FA9ZJ9GC",
  workspace_id: "T03C0ENJ6UE",
  channel_name: "roger-garza",
  workspace_name: "railsconf2022"
)
```

If the user provides a Slack URL like `https://app.slack.com/client/T03C0ENJ6UE/D03FA9ZJ9GC`, extract the workspace_id and channel_id from the path segments.

## Triggering a Sync

```
sync_slack_channel(channel_name: "roger-garza")
```

You can also use `channel_id` or database `id` if preferred.

This creates and runs a `slack-channel-sync` kdag job with 3 code steps:

1. **export** (up to 600s) — Launches Chromium via Playwright, authenticates to Slack, fetches messages via Web API. Outputs a markdown file.
2. **split** (up to 60s) — Splits the export into monthly markdown files for granular ingestion.
3. **ingest** (up to 120s) — Sends split files to the kvec vector collection and updates the `slack_channels` row with `last_message_ts`, `last_exported_at`, and `message_count`.

Monitor progress with `get_kdag_job(job_id)`. The export step takes the longest due to browser automation.

### Incremental Exports

After the first sync, subsequent runs only fetch messages newer than `last_message_ts`. The export script passes `--from-date` to the Playwright exporter automatically.

## Export Directory

The default export directory is controlled by the `slack.exportDir` setting (default: `chats`). Files are written relative to the project root:

```
<project_root>/<slack.exportDir>/<channel_name>.md       # raw export
<project_root>/<slack.exportDir>/<channel_name>-split/   # monthly files
```

Per-channel override: set `export_path` when registering to use a different path or naming convention. For example, if your project uses `chats/roger-garza-messages.md`, register with `export_path: "chats/roger-garza-messages"`.

To change the global default, update the setting via the API or UI (Settings page, key: `slack.exportDir`).

## Searching Ingested Messages

```
search_slack(q: "deployment discussion", channel: "engineering", mode: "semantic")
```

Modes: `semantic` (default, vector similarity) or `keyword` (text contains).

Optional filters: `channel`, `workspace`, `limit`.

## Troubleshooting

- **Export step fails with ENOENT**: The Playwright script must exist at `<project_root>/scripts/export_slack_channel.ts`. Verify the project's `path` column in the database points to the monorepo root.
- **Ingest step fails with "fetch failed"**: The ingest script calls the khef API. Ensure `PORT` env var matches the running API port (the script uses `KHEF_API_URL` or falls back to `http://localhost:${PORT}`).
- **No messages found after sync**: Check that the kdag job completed all 3 steps via `get_kdag_job`. The ingest step must finish for messages to appear in `search_slack`.
- **Playwright authentication**: The export script uses existing browser state. If Slack authentication fails, the user may need to log in manually in the Chromium profile first.

## Workflow Summary

1. Get the Slack channel URL or IDs from the user
2. `register_slack_channel(...)` to add to tracking
3. `sync_slack_channel(channel_name: "...")` to run the pipeline
4. `get_kdag_job(job_id)` to monitor progress
5. `search_slack(q: "...")` to verify messages are searchable
6. For re-syncs, just call `sync_slack_channel` again — it picks up incrementally
