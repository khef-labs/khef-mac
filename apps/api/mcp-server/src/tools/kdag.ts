import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatJobDefinitions, formatJobDefinition, formatJobList, formatJob, formatStep, formatDefinitionSnapshots, formatDefinitionSnapshot, formatInputTypes } from "../formatters/kdag.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function parseMaybeJsonArray(value: unknown, fieldName: string): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error(`${fieldName} must be an array`);
    }
    return parsed;
  } catch {
    throw new Error(`${fieldName} must be an array or a JSON-encoded array`);
  }
}

function toKebab(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function detectExt(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { JSON.parse(trimmed); return 'json'; } catch {}
  }
  const lines = trimmed.split('\n').filter(l => l.trim());
  if (lines.length >= 2) {
    const header = lines[0];
    // Skip if header looks like markdown (headings, lists, links, bold/italic)
    if (/^#{1,6}\s|^\s*[-*]\s|^\||\[.*\]\(|^\*\*|^>\s/.test(header)) {
      return 'md';
    }
    const cc = (s: string) => (s.match(/,/g) || []).length;
    const first = cc(header);
    // Require at least 2 commas (3+ fields), consistent count across rows,
    // Header fields should look like column names (short, no sentence punctuation,
    // at least one single-word identifier like "name" or "id")
    const fields = header.split(',').map(f => f.trim());
    const columnLike = fields.filter(f => f.length <= 30 && !/[.!?;]/.test(f));
    const hasIdentifier = fields.some(f => /^[\w-]+$/.test(f.trim()));
    const looksLikeHeader = columnLike.length >= fields.length * 0.7 && hasIdentifier;
    if (first >= 2 && looksLikeHeader && lines.slice(1, 6).every(l => cc(l) === first)) {
      return 'csv';
    }
  }
  return 'md';
}

function stepFileSlug(step: { definition_step_index: number; step_type: string; step_index: number }): string {
  const n = step.definition_step_index + 1;
  if (step.step_type === 'synthesis') return `step-${n}-synthesis`;
  if (step.step_type === 'batch_summary') return `step-${n}-batch-${step.step_index + 1}`;
  return `step-${n}`;
}

export const tools: Tool[] = [
  {
  name: "list_job_definitions",
  description:
    "List all kdag pipeline definitions with step counts, job counts, and timestamps. Use get_job_definition for full details on a specific definition.",
  inputSchema: {
    type: "object",
    properties: {},
  },
},

  {
  name: "get_job_definition",
  description:
    "Get a kdag pipeline definition by key. Returns full details including ordered steps (with type, agent, input wiring, config) and declared inputs.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Definition key (e.g., 'session-summary', 'custom', 'chained-refinement')",
      },
    },
    required: ["key"],
  },
},

  {
  name: "create_job_definition",
  description:
    "Create a new kdag pipeline definition. Define ordered steps with step_type (prompt, map_reduce, or code), agent overrides, input wiring (job_input, previous_step, template), and optional per-step config. Code steps execute a script file (config.script_path) as a subprocess with input via stdin (.ts/.tsx via tsx, .py via python3, others via node). Declare required/optional inputs.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Unique key for the definition (kebab-case)",
      },
      name: {
        type: "string",
        description: "Display name",
      },
      description: {
        type: "string",
        description: "What this pipeline does",
      },
      steps: {
        type: "array",
        description: "Ordered pipeline steps",
        items: {
          type: "object",
          properties: {
            key: { type: "string", description: "Step key (unique within definition)" },
            name: { type: "string", description: "Step display name" },
            step_type: { type: "string", description: "Step type: 'prompt' (single LLM call), 'map_reduce' (fan-out/fan-in), or 'code' (execute script file). Default: prompt" },
            assistant_handle: { type: "string", description: "Agent override: claude-code, gemini, codex-cli, or null to inherit (not used for code steps)" },
            model: { type: "string", description: "Model for this step (e.g., 'claude-opus-4-7', 'gemini-2.5-pro'). If not set, falls back to run-level model or backend default." },
            prompt_handle: { type: "string", description: "Prompt template handle (optional, not used for code steps)" },
            input_source: { type: "string", description: "Input source: 'job_input', 'previous_step', or 'template'" },
            input_config: { type: "object", description: "Input config: {input_type} for job_input, {step_key} for previous_step, {template} for template" },
            config: { type: "object", description: "Step config. For map_reduce: chunk_size, threshold, batch_prompt_handle, merge_template, skip_synthesis (boolean — skip final LLM call and concatenate batch outputs directly), split_mode ('csv_row' for CSV-aware splitting with header preservation, 'line' for line-based splitting; default: paragraph-based), batch_size (number of rows/lines per batch when split_mode is csv_row or line; default: 1), batch_timeout_ms / synthesis_timeout_ms (per-phase timeout overrides in ms, both fall back to the step-level timeout_ms; only apply when fan-out happens). For code: script_path (path to script that reads stdin and writes stdout; .ts/.tsx via tsx, .py via python3, others via node). For Gemini steps: use_google_search (boolean), use_thinking (boolean — enable chain-of-thought reasoning), thinking_budget (number — token budget, omit to let API decide)" },
            timeout_ms: { type: "number", description: "Per-step timeout in ms (default: 120000). Guidance: code steps ~30s, Gemini ~60-120s, Claude prompt ~120s, Claude with large context ~300-600s, map_reduce batches ~120s each" },
          },
          required: ["key", "name"],
        },
      },
      inputs: {
        type: "array",
        description: "Declared job inputs",
        items: {
          type: "object",
          properties: {
            input_type: { type: "string", description: "Input type key (use list_kdag_input_types to see available types, or create_kdag_input_type to register new ones)" },
            required: { type: "boolean", description: "Whether this input is required (default: false)" },
            description: { type: "string", description: "Help text for this input" },
            example: { type: "string", description: "Example content showing what a well-formed input looks like" },
          },
          required: ["input_type"],
        },
      },
    },
    required: ["key", "name", "steps"],
  },
},

  {
  name: "update_job_definition",
  description:
    "Update an existing kdag pipeline definition. IMPORTANT: steps and inputs arrays are REPLACED IN FULL — any field you omit (prompt_handle, model, config, timeout_ms) will be reset to defaults. Always call get_job_definition first to see current state including prompt_handle, config (thinking, grounding, script_path, chunk_size), model, and timeout_ms for each step. A snapshot is automatically saved before each update. Use list_definition_snapshots + restore_definition_snapshot to undo mistakes.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Definition key to update",
      },
      name: {
        type: "string",
        description: "New display name",
      },
      description: {
        type: "string",
        description: "New description",
      },
      steps: {
        type: "array",
        description: "Replacement steps (full array, not partial). Each step can target a different agent via assistant_handle for multi-agent pipelines.",
        items: {
          type: "object",
          properties: {
            key: { type: "string", description: "Step key (unique within definition)" },
            name: { type: "string", description: "Step display name" },
            step_type: { type: "string", description: "Step type: 'prompt' (single LLM call), 'map_reduce' (fan-out/fan-in), or 'code' (execute script file). Default: prompt" },
            assistant_handle: { type: "string", description: "Per-step agent override: claude-code, gemini, codex-cli, or null to inherit from job default. Enables multi-agent pipelines (e.g., classify with Gemini, refine with Claude)" },
            model: { type: "string", description: "Model for this step (e.g., 'claude-opus-4-7', 'gemini-2.5-pro'). If not set, falls back to run-level model or backend default." },
            prompt_handle: { type: "string", description: "Prompt template handle (optional, not used for code steps)" },
            input_source: { type: "string", description: "Input source: 'job_input', 'previous_step', or 'template'" },
            input_config: { type: "object", description: "Input config: {input_type} for job_input, {step_key} for previous_step, {template} for template" },
            config: { type: "object", description: "Step config. For map_reduce: chunk_size, threshold, batch_prompt_handle, merge_template, skip_synthesis (boolean — skip final LLM call and concatenate batch outputs directly), split_mode ('csv_row' for CSV-aware splitting with header preservation, 'line' for line-based splitting; default: paragraph-based), batch_size (number of rows/lines per batch when split_mode is csv_row or line; default: 1), batch_timeout_ms / synthesis_timeout_ms (per-phase timeout overrides in ms, both fall back to the step-level timeout_ms; only apply when fan-out happens). For code: script_path (path to script that reads stdin and writes stdout; .ts/.tsx via tsx, .py via python3, others via node). For Gemini steps: use_google_search (boolean), use_thinking (boolean — enable chain-of-thought reasoning), thinking_budget (number — token budget, omit to let API decide)" },
            timeout_ms: { type: "number", description: "Per-step timeout in ms (default: 120000). Guidance: code steps ~30s, Gemini ~60-120s, Claude prompt ~120s, Claude with large context ~300-600s, map_reduce batches ~120s each" },
          },
          required: ["key", "name"],
        },
      },
      inputs: {
        type: "array",
        description: "Replacement inputs (full array, not partial)",
        items: {
          type: "object",
          properties: {
            input_type: { type: "string", description: "Input type key (use list_kdag_input_types to see available types, or create_kdag_input_type to register new ones)" },
            required: { type: "boolean", description: "Whether this input is required (default: false)" },
            description: { type: "string", description: "Help text for this input" },
            example: { type: "string", description: "Example content showing what a well-formed input looks like" },
          },
          required: ["input_type"],
        },
      },
    },
    required: ["key"],
  },
},

  {
  name: "delete_job_definition",
  description:
    "Delete a kdag pipeline definition by key. Blocked if the definition is a system definition or has existing jobs.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Definition key to delete",
      },
    },
    required: ["key"],
  },
},

  {
  name: "create_kdag_job",
  description:
    "Create a new kdag job for a pipeline definition. Provide the definition key, optional assistant handle, and input values (map of input_type to content). Does not start execution — call run_kdag_job to begin.",
  inputSchema: {
    type: "object",
    properties: {
      definition_key: {
        type: "string",
        description: "Pipeline definition key to run (e.g., 'custom', 'session-summary')",
      },
      assistant_handle: {
        type: "string",
        description: "Default agent for steps: claude-code, gemini, or codex-cli (default: claude-code)",
      },
      inputs: {
        type: "object",
        description: "Input values as {input_type: content} map (e.g., {prompt: 'Analyze this...', transcript: '...'})",
        additionalProperties: { type: "string" },
      },
      project_id: {
        type: "string",
        description: "Optional project handle, name, or UUID to associate the job with",
      },
    },
    required: ["definition_key"],
  },
},

  {
  name: "run_kdag_job",
  description:
    "Start, queue, or rerun a kdag job. Jobs run immediately if the worker pool has capacity (controlled by kdag.maxConcurrency setting, default 1). When the pool is full, jobs queue automatically (returns status 'queued' with position). Poll with get_kdag_job to check progress. Set queue=false to get a 409 instead of queuing. Use from_step to rerun a completed job from a specific step (earlier steps are skipped using cached outputs from the previous run). Note: Gemini-specific options are set in the step's config object via update_job_definition (e.g., config: { use_thinking: true, thinking_budget: 4096, use_google_search: true }). Use get_job_definition to inspect current step config.",
  inputSchema: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        description: "Job UUID to execute",
      },
      from_step: {
        type: "string",
        description: "Step key to rerun from (e.g., 'postprocess'). Requires a previous completed run. Steps before this key are skipped (outputs copied from the last completed run). Use get_kdag_job or get_job_definition to see available step keys.",
      },
      from_batch: {
        type: "number",
        description: "Batch index (0-based) to rerun from within a map_reduce step. Use with from_step to skip earlier batches. Batches before this index are copied from the previous run.",
      },
      model: {
        type: "string",
        description: "Model override for this run (e.g., 'claude-opus-4-7', 'gemini-2.5-pro', 'o4-mini'). Per-step model in the definition takes priority over this. Falls back to backend default if not set.",
      },
      step_timeout_ms: {
        type: "number",
        description: "Override per-step timeout for this run (applies to all steps). If not set, uses each step's configured timeout_ms or the default 120000ms. Set higher for long-running steps (e.g., 300000 for 5 min, 600000 for 10 min)",
      },
      batch_delay_ms: {
        type: "number",
        description: "Delay in ms between map_reduce batch chunks (rate-limit pacing). Overrides the step's config.batch_delay_ms for this run. 0 = no delay (default).",
      },
      queue: {
        type: "boolean",
        description: "If true (default), queue the job when another is running. If false, return an error instead.",
      },
    },
    required: ["job_id"],
  },
},

  {
  name: "get_kdag_job",
  description:
    "Get full details of a kdag job including runs, step results (with input/output text), and final output. Use to check job status and retrieve results.",
  inputSchema: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        description: "Job UUID",
      },
    },
    required: ["job_id"],
  },
},

  {
  name: "get_kdag_step",
  description:
    "Get a specific step's results from a kdag job by step key. Returns full input/output text, status, duration, and metadata. For map_reduce steps, returns all batch and synthesis records.",
  inputSchema: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        description: "Job UUID",
      },
      step: {
        type: "string",
        description: "Definition step key (e.g., 'analyze', 'refine', 'execute')",
      },
    },
    required: ["job_id", "step"],
  },
},

  {
  name: "list_kdag_jobs",
  description:
    "List kdag jobs with optional filters. Returns jobs with their latest run status, progress, and duration.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description: "Filter by status: pending, running, completed, failed",
      },
      job_type: {
        type: "string",
        description: "Filter by legacy job type key: session_summary, custom",
      },
      definition_key: {
        type: "string",
        description: "Filter by pipeline definition key (e.g., 'session-summary', 'chained-refinement')",
      },
      project: {
        type: "string",
        description: "Filter by project handle or name",
      },
      limit: {
        type: "number",
        description: "Results per page (default: 20)",
      },
      offset: {
        type: "number",
        description: "Results to skip (default: 0)",
      },
    },
  },
},

  {
  name: "delete_kdag_job",
  description:
    "Delete a kdag job and all its runs, steps, inputs, and outputs. This is permanent and cannot be undone.",
  inputSchema: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        description: "Job UUID to delete",
      },
    },
    required: ["job_id"],
  },
},

  {
  name: "list_kdag_input_types",
  description:
    "List all registered kdag input types. Returns built-in types (prompt, chunk_prompt, system_prompt, transcript, existing_summary) plus any custom types. Use before creating definitions to see available input types.",
  inputSchema: {
    type: "object",
    properties: {},
  },
},

  {
  name: "create_kdag_input_type",
  description:
    "Register a custom kdag input type. Once registered, it can be used in pipeline definitions as an input_type. Key must start with a lowercase letter and contain only lowercase letters, digits, hyphens, and underscores.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Unique key for the input type (e.g., 'research_sources', 'email', 'code-snippet')",
      },
      description: {
        type: "string",
        description: "Human-readable description of what this input type represents",
      },
      format: {
        type: "string",
        description: "Content format hint: text, json, csv, markdown, url-list, code, xml. Advisory only — not enforced.",
      },
    },
    required: ["key"],
  },
},

  // ── Definition Snapshots & Cloning ─────────────────────────────────

  {
  name: "list_definition_snapshots",
  description:
    "List version snapshots for a kdag pipeline definition. Snapshots are automatically created before each update to steps or inputs, and can also be created manually. Use restore_definition_snapshot to roll back to a previous state.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Definition key",
      },
    },
    required: ["key"],
  },
},

  {
  name: "get_definition_snapshot",
  description:
    "Get full details of a definition snapshot including all steps (with prompt_handle, model, config, timeout_ms) and inputs as they were at that point in time.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Definition key",
      },
      snapshot_number: {
        type: "number",
        description: "Snapshot number to retrieve",
      },
    },
    required: ["key", "snapshot_number"],
  },
},

  {
  name: "snapshot_job_definition",
  description:
    "Create a manual snapshot of a definition's current state (steps, inputs, name, description). Use before making experimental changes so you can restore later.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Definition key to snapshot",
      },
    },
    required: ["key"],
  },
},

  {
  name: "restore_definition_snapshot",
  description:
    "Restore a definition to a previous snapshot state. Automatically saves the current state as a safety snapshot before restoring. Replaces all steps, inputs, name, and description.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Definition key",
      },
      snapshot_number: {
        type: "number",
        description: "Snapshot number to restore from",
      },
    },
    required: ["key", "snapshot_number"],
  },
},

  {
  name: "clone_job_definition",
  description:
    "Clone a pipeline definition to a new key. Copies all steps (including prompt_handle, model, config, timeout_ms), inputs, and description. Use to create a variant without modifying the original.",
  inputSchema: {
    type: "object",
    properties: {
      source_key: {
        type: "string",
        description: "Definition key to clone from",
      },
      new_key: {
        type: "string",
        description: "New definition key (kebab-case)",
      },
      new_name: {
        type: "string",
        description: "Optional display name for the clone (defaults to 'Original Name (copy)')",
      },
    },
    required: ["source_key", "new_key"],
  },
},

  // ── Export ───────────────────────────────────────────────────────────

  {
  name: "export_kdag_job",
  description:
    "Export all inputs and outputs of a kdag job to files on disk. Writes each job input, step input/output, and final output as individual files with auto-detected extensions (.md, .json, .csv). File names use the definition name in kebab-case with step indexing.",
  inputSchema: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        description: "Job UUID to export",
      },
      path: {
        type: "string",
        description: "Target directory path (created if absent)",
      },
    },
    required: ["job_id", "path"],
  },
},

{
  name: "export_job_definition",
  description:
    "Export a kdag job definition and all its assets (referenced prompts, code step scripts) as seed-compatible files. Writes definitions/<key>.md, prompts/<handle>.md, and scripts to the target directory. The exported files can be dropped into another khef instance's db/seed/ directories and seeded.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Definition key to export (e.g., 'session-summary', 'slack-channel-sync')",
      },
      path: {
        type: "string",
        description: "Target directory to write the bundle into (created if absent)",
      },
    },
    required: ["key", "path"],
  },
},
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, _dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "list_job_definitions": {
      const result = await client.listJobDefinitions();
      return {
        content: [{ type: "text", text: formatJobDefinitions(result) }],
      };
    }

    case "get_job_definition": {
      const result = await client.getJobDefinition(args.key as string);
      return {
        content: [{ type: "text", text: formatJobDefinition(result) }],
      };
    }

    case "create_job_definition": {
      const parsedSteps = parseMaybeJsonArray(args.steps, "steps");
      const parsedInputs = parseMaybeJsonArray(args.inputs, "inputs");
      const result = await client.createJobDefinition({
        key: args.key as string,
        name: args.name as string,
        description: args.description as string | undefined,
        steps: parsedSteps as Array<{
          key: string;
          name: string;
          step_type?: string;
          assistant_handle?: string | null;
          prompt_handle?: string | null;
          input_source?: string;
          input_config?: Record<string, unknown>;
          config?: Record<string, unknown>;
          timeout_ms?: number;
        }>,
        inputs: parsedInputs as Array<{
          input_type: string;
          required?: boolean;
          description?: string;
        }> | undefined,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "update_job_definition": {
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.description !== undefined) body.description = args.description;
      if (args.steps !== undefined) body.steps = parseMaybeJsonArray(args.steps, "steps");
      if (args.inputs !== undefined) body.inputs = parseMaybeJsonArray(args.inputs, "inputs");
      const result = await client.updateJobDefinition(args.key as string, body as any);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "delete_job_definition": {
      const result = await client.deleteJobDefinition(args.key as string);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "create_kdag_job": {
      const result = await client.createKdagJob({
        definition_key: args.definition_key as string,
        assistant_handle: args.assistant_handle as string | undefined,
        inputs: args.inputs as Record<string, string> | undefined,
        project_id: args.project_id as string | undefined,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "run_kdag_job": {
      const result = await client.runKdagJob(
        args.job_id as string,
        {
          from_step: args.from_step as string | undefined,
          from_batch: args.from_batch as number | undefined,
          model: args.model as string | undefined,
          step_timeout_ms: args.step_timeout_ms as number | undefined,
          batch_delay_ms: args.batch_delay_ms as number | undefined,
          queue: args.queue as boolean | undefined,
        },
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "get_kdag_job": {
      const result = await client.getKdagJob(args.job_id as string);
      return {
        content: [{ type: "text", text: formatJob(result) }],
      };
    }

    case "get_kdag_step": {
      const result = await client.getKdagStep(args.job_id as string, args.step as string);
      return {
        content: [{ type: "text", text: formatStep(result) }],
      };
    }

    case "list_kdag_jobs": {
      const result = await client.listKdagJobs({
        status: args.status as string | undefined,
        job_type: args.job_type as string | undefined,
        definition_key: args.definition_key as string | undefined,
        project: args.project as string | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
      });
      return {
        content: [{ type: "text", text: formatJobList(result) }],
      };
    }

    case "list_kdag_input_types": {
      const fmt = (args.format as string) || "text";
      const result = await client.listKdagInputTypes();
      return {
        content: [{ type: "text", text: fmt === "text" ? formatInputTypes(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "delete_kdag_job": {
      const result = await client.deleteKdagJob(args.job_id as string);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "create_kdag_input_type": {
      const result = await client.createKdagInputType({
        key: args.key as string,
        description: args.description as string | undefined,
        format: args.format as string | undefined,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "list_definition_snapshots": {
      const result = await client.listDefinitionSnapshots(args.key as string);
      return {
        content: [{ type: "text", text: formatDefinitionSnapshots(result) }],
      };
    }

    case "get_definition_snapshot": {
      const result = await client.getDefinitionSnapshot(
        args.key as string,
        args.snapshot_number as number
      );
      return {
        content: [{ type: "text", text: formatDefinitionSnapshot(result) }],
      };
    }

    case "snapshot_job_definition": {
      const result = await client.createDefinitionSnapshot(args.key as string);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "restore_definition_snapshot": {
      const result = await client.restoreDefinitionSnapshot(
        args.key as string,
        args.snapshot_number as number
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "clone_job_definition": {
      const result = await client.cloneJobDefinition(
        args.source_key as string,
        args.new_key as string,
        args.new_name as string | undefined
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "export_kdag_job": {
      const data = await client.getKdagJob(args.job_id as string, true) as any;
      const job = data.job || data;
      const targetPath = args.path as string;

      const baseName = toKebab(job.definition_name || job.definition_key || 'job');
      mkdirSync(targetPath, { recursive: true });

      const written: string[] = [];
      const writeFile = (name: string, content: string) => {
        const ext = detectExt(content);
        const filename = `${name}.${ext}`;
        writeFileSync(join(targetPath, filename), content, 'utf-8');
        written.push(`${filename} (${content.length} chars)`);
      };

      // Job inputs
      const inputs = data.inputs || [];
      for (const input of inputs) {
        if (input.content) {
          writeFile(`${baseName}-input-${toKebab(input.input_type)}`, input.content);
        }
      }

      // Steps from latest run
      const runs = data.runs || [];
      const latestRun = runs[0];
      if (latestRun) {
        const steps = latestRun.steps || [];
        for (const step of steps) {
          const slug = stepFileSlug(step);
          if (step.input_text) {
            writeFile(`${baseName}-${slug}-input`, step.input_text);
          }
          const output = step.output_text ?? step.output_preview;
          if (output) {
            writeFile(`${baseName}-${slug}-output`, output);
          }
        }

        // Final job output
        if (latestRun.output) {
          writeFile(`${baseName}-output`, latestRun.output);
        }
      }

      const summary = written.length > 0
        ? `Exported ${written.length} files to ${targetPath}:\n${written.map(f => `  ${f}`).join('\n')}`
        : `No content to export for job ${args.job_id}`;

      return {
        content: [{ type: "text", text: summary }],
      };
    }

    case "export_job_definition": {
      const data = await client.exportJobDefinition(args.key as string);
      const targetPath = args.path as string;

      mkdirSync(targetPath, { recursive: true });
      const written: string[] = [];

      for (const file of data.files) {
        const filePath = join(targetPath, file.path);
        const dir = filePath.substring(0, filePath.lastIndexOf('/'));
        if (dir) mkdirSync(dir, { recursive: true });
        writeFileSync(filePath, file.content, 'utf-8');
        written.push(`${file.path} (${file.content.length} chars)`);
      }

      const result = written.length > 0
        ? `Exported definition '${args.key}' — ${written.length} files to ${targetPath}:\n${written.map(f => `  ${f}`).join('\n')}`
        : `No files to export for definition '${args.key}'`;

      return {
        content: [{ type: "text", text: result }],
      };
    }

    default:
      return null;
  }
}
