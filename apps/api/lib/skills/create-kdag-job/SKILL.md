---
name: create-kdag-job
description: This skill should be used for ANY kdag, job definition, or pipeline question — including "create a kdag job", "run a kdag job", "build a pipeline", "create a job definition", "new kdag definition", "how does the executor work", "step timeout", "map_reduce behavior", "synthesis", "batch_delay_ms", "retry semantics", "job inputs", "step wiring", or any question about the session-summary / custom / slack-channel-sync definitions. Load this skill whenever the conversation touches kdag internals, even for read-only questions, before reaching for the codebase.
---

# Kdag Reference

Authoritative guide for kdag pipeline definitions, jobs, and executor internals. Kdag is a definition-driven pipeline orchestration system — definitions declare reusable multi-step pipelines, jobs execute them asynchronously via a worker pool.

## Before Starting

Fetch the authoritative kdag reference memory for full technical details:

```
get_memory_by_handle(handle: "ctx-kdag-pipeline-system", project_id: "user")
```

Do NOT explore the codebase for kdag context — the memory is self-contained.

## Mental Model

Understand the separation between reasoning and execution layers:

| Layer | Step Types | Can Do | Cannot Do |
|-------|-----------|--------|-----------|
| Reasoning | `prompt`, `map_reduce` | Text analysis, generation, summarization | API calls, file I/O, DB queries, MCP tools |
| Execution | `code` | API calls, file transforms, validation, side effects | LLM reasoning (no model access) |

Common pattern: `prompt` composes a plan -> `code` executes it -> `prompt` analyzes results.

## Creating a Definition

### 1. Check Existing Input Types

```
list_kdag_input_types()
```

Built-in types: `prompt`, `chunk_prompt`, `system_prompt`, `transcript`, `existing_summary`. Register custom types first if needed via `create_kdag_input_type`.

### 2. Choose Creation Method

**Via seed file** (preferred for persistent definitions):

Create `apps/api/db/seed/definitions/<key>.md` with YAML frontmatter:

```yaml
---
key: my-pipeline
name: My Pipeline
description: What this pipeline does
is_system: false
inputs:
  - type: prompt
    required: true
    description: Content to process
steps:
  - key: analyze
    name: Analyze Input
    step_type: prompt
    input_source: job_input
    input_config:
      input_type: prompt
    timeout_ms: 120000
---
```

Run `npm run db:seed` to upsert. The body after frontmatter is ignored — all config lives in frontmatter.

**Via MCP tool** (for ad-hoc definitions):

```
create_job_definition(key: "my-pipeline", name: "My Pipeline", steps: [...], inputs: [...])
```

### 3. Wire Step Inputs

Each step declares where its input comes from:

| Source | Config | Use When |
|--------|--------|----------|
| `job_input` | `{ input_type: "prompt" }` | First step reading from job inputs |
| `previous_step` | `{ step_key: "analyze" }` | Chaining step output to next step |
| `template` | `{ template: "{{job_input.prompt}}\n\n{{step.analyze}}" }` | Composing from multiple sources |

Template placeholders: `{{job_input.TYPE}}`, `{{step.STEP_KEY}}`.

### 4. Configure Step Types

**prompt** — Single LLM call. Set `prompt_handle` for a DB-stored prompt template, or rely on the `prompt` job input as fallback. The `input_source` controls the data sent to the LLM; the prompt instruction comes separately.

**map_reduce** — Fan-out/fan-in for large inputs. Key config:
- `chunk_size` (default 50000), `threshold` (default 100000, set 0 to always split)
- `split_mode` — `"csv_row"` for CSV-aware splitting with header preservation, `"line"` for line-based splitting (default: paragraph-based splitting on `\n\n`)
- `batch_size` — number of rows/lines per batch when `split_mode` is `"csv_row"` or `"line"` (default: 1). For csv_row, each batch gets the CSV header prepended
- `batch_prompt_handle` for chunk processing, `merge_template` for assembly
- `skip_synthesis: true` to concatenate without final LLM call
- `batch_delay_ms` for rate-limit pacing between chunks

**CSV row splitting example** — process each row of a CSV individually:

```yaml
steps:
  - key: process
    name: Process CSV Rows
    step_type: map_reduce
    input_source: job_input
    input_config:
      input_type: prompt
    config:
      split_mode: csv_row
      batch_size: 1
      threshold: 0
      skip_synthesis: true
inputs:
  - type: prompt
    required: true
    description: CSV data to process
  - type: chunk_prompt
    required: true
    description: Prompt for processing each row
```

With `split_mode: csv_row`, the CSV header is automatically prepended to each batch. Set `threshold: 0` to always split (even small inputs). The `chunk_prompt` job input provides the per-row instruction. Each batch receives valid CSV: header + N data rows (controlled by `batch_size`).

**code** — Subprocess execution. Config: `script_path` (relative to project root). Place scripts at `apps/api/scripts/kdag/<name>.ts`. Read all stdin as JSON, write result to stdout as JSON. Always strip markdown fences from prior LLM step output before parsing.

### 5. Per-Step Agent and Model Overrides

Each step can target a different backend and model:

```yaml
- key: classify
  assistant_handle: gemini
  model: gemini-2.5-flash
  config:
    use_google_search: true
- key: refine
  assistant_handle: claude-code
  model: claude-opus-4-7
```

Available backends: `claude-code`, `gemini`, `codex-cli`. Model fallback: step-level -> run-level -> backend default.

### 6. Set Timeouts

Guidance: code steps ~30s, short prompts ~60s, standard prompts ~120s, large context ~300-600s.

Three-level fallback (highest precedence first):
1. Run-level `step_timeout_ms` (from `run_kdag_job`)
2. Step-level `timeout_ms` (from the definition)
3. `STEP_TIMEOUT_MS = 120000` default (`apps/api/src/services/kdag-executor.ts:83`)

Resolution: `kdag-executor.ts:998` — `opts?.stepTimeoutMs || defStep.timeout_ms || STEP_TIMEOUT_MS`.

**Map-reduce timeout semantics (important):** For `map_reduce` steps, the resolved `timeoutMs` is applied **independently to every LLM subprocess call** — each batch `runPrompt` call and the synthesis `runPrompt` call. There is no aggregate cap on the whole step.

Per-phase overrides (added because synthesis often needs a different budget than batches):

| Config key | Applies to | Falls back to |
|------------|-----------|---------------|
| `batch_timeout_ms` | Every batch call in the fan-out loop | step-level `timeout_ms` |
| `synthesis_timeout_ms` | The final synthesis call | step-level `timeout_ms` |

Both only take effect when fan-out actually happens (input size exceeds `threshold`). The below-threshold single-pass branch keeps using the step-level `timeout_ms` — it is neither a batch nor a synthesis. `skip_synthesis: true` (config) collapses the synthesis call entirely; in that mode only batch budgets matter.

Example: bump synthesis to 10 min while keeping batches at 5 min:
```yaml
timeout_ms: 300000           # step default, used by batches
config:
  synthesis_timeout_ms: 600000
```

## Creating and Running a Job

### 1. Create the Job

```
create_kdag_job(
  definition_key: "my-pipeline",
  inputs: { prompt: "Content to analyze" },
  project_id: "khef"
)
```

Returns a `job_id`. The job is not running yet. Inputs are stored as an immutable snapshot.

### 2. Run the Job

```
run_kdag_job(job_id: "<id>")
```

Jobs run asynchronously via a worker pool:
- Pool has capacity -> execution starts immediately (status: `running`)
- Pool is full -> job queues automatically (status: `queued` with position)
- Pool size controlled by `kdag.maxConcurrency` setting (default 3)
- Set `queue: false` to get a 409 instead of queuing

Optional overrides: `model`, `step_timeout_ms`, `batch_delay_ms`.

### 3. Check Progress

```
get_kdag_job(job_id: "<id>")
```

Poll to check status, step results, and final output. For a specific step's full input/output:

```
get_kdag_step(job_id: "<id>", step: "analyze")
```

### 4. Export Results

```
export_kdag_job(job_id: "<id>", path: "/tmp/my-job-export")
```

Writes individual files per step with auto-detected extensions (.json, .csv, .md).

## Key Rules and Pitfalls

1. **Job inputs are immutable.** Rerun/retry uses the same stored inputs. Create a new job when inputs must change.

2. **`update_job_definition` replaces steps and inputs IN FULL.** Always call `get_job_definition` first to see current state. A snapshot is auto-saved before each update.

3. **Custom input types must exist before referencing them.** Use `list_kdag_input_types` to check, `create_kdag_input_type` to register.

4. **Prompt steps need both a prompt AND input.** The `input_source` controls the data; the instruction comes from `prompt_handle` or the `prompt` job input. A `template` input source does NOT replace the prompt.

5. **Code step scripts must handle markdown fences.** LLM output from prior steps may wrap JSON in code fences — always strip before parsing.

6. **Use dedicated MCP tools for job results.** Use `get_kdag_job` and `get_kdag_step`, not `query_kdag` SQL.

7. **Path-like inputs get auto-normalized.** Input type keys containing `path` or `dir` trigger tilde expansion and path resolution.

8. **Seed file format is YAML frontmatter only.** The markdown body is ignored for definitions.

9. **Prompt steps inherit cwd from the job's project.** The executor resolves `cwd` from `project.path` in the database and passes it to all steps. For cross-project pipelines (e.g., a homework job created from the khef project), prompt steps see `cwd = /path/to/khef` which can mislead the LLM into thinking it can't access files elsewhere. Workaround: add explicit instructions to the prompt template telling the LLM to work from the provided input text only and ignore its working directory.

10. **Tilde in project paths causes spawn ENOENT.** `child_process.spawn` doesn't expand `~`. If a project path is stored as `~/projects/...`, code steps fail with a misleading `spawn ENOENT` error (reported against the command name, not the missing directory). Fixed via `expandTilde()` in the executor, but ensure project paths are stored as absolute paths to avoid surprises.

## MCP Tools Quick Reference

| Task | Tool |
|------|------|
| List definitions | `list_job_definitions` |
| Inspect definition | `get_job_definition(key)` |
| Create definition | `create_job_definition(key, name, steps, inputs)` |
| Update definition | `update_job_definition(key, ...)` |
| List input types | `list_kdag_input_types` |
| Register input type | `create_kdag_input_type(key, description?, format?)` |
| Create job | `create_kdag_job(definition_key, inputs)` |
| Run job | `run_kdag_job(job_id)` |
| Check status/output | `get_kdag_job(job_id)` |
| Get step detail | `get_kdag_step(job_id, step)` |
| Export to disk | `export_kdag_job(job_id, path)` |
| List jobs | `list_kdag_jobs` |
