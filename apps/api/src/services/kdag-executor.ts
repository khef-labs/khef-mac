/**
 * Job executor.
 *
 * Invoked on-demand via POST /api/prompt/job/:id/run.
 * Creates a job_run, spawns `claude -p`, stores output in job_outputs.
 * Supports map-reduce for large sessions (batches + synthesis).
 */

import { spawn } from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'os';
import Papa from 'papaparse';
import { workerLogger } from '../lib/logger';
import { query, querySingle, getClient } from '../db/client';
import { generateContent } from './gemini';
import { spawnAsync } from './gcloud';
import { checkGeminiStatus } from './gemini';
import { storeJobError } from './job-errors';

/**
 * Store a job run failure in Redis for quick agent retrieval.
 * Non-blocking — errors are logged but don't affect the caller.
 */
async function recordJobError(jobId: string, runId: string, definitionId: string | null, jobTypeKey: string, error: string, durationMs: number): Promise<void> {
  try {
    const failedStep = await querySingle<{ step_key: string; step_name: string; metadata: string | null }>(
      `SELECT ds.key as step_key, ds.name as step_name, js.metadata::text
       FROM kdag.job_steps js
       JOIN kdag.job_runs jr ON jr.id = js.job_run_id
       JOIN kdag.jobs j ON j.id = jr.job_id
       JOIN kdag.job_definition_steps ds ON ds.definition_id = j.definition_id AND ds.step_index = js.definition_step_index
       WHERE js.job_run_id = $1 AND js.status = 'failed'
       ORDER BY js.definition_step_index DESC LIMIT 1`,
      [runId]
    );
    const stepMeta = failedStep?.metadata ? (() => { try { return JSON.parse(failedStep.metadata); } catch { return {}; } })() : {};
    const defKey = definitionId
      ? (await querySingle<{ key: string }>('SELECT key FROM kdag.job_definitions WHERE id = $1', [definitionId]))?.key || 'unknown'
      : jobTypeKey;
    await storeJobError({
      jobId,
      runId,
      stepKey: failedStep?.step_key || 'unknown',
      stepName: failedStep?.step_name || 'unknown',
      definitionKey: defKey,
      error,
      model: stepMeta.model,
      backend: stepMeta.backend,
      durationMs,
    });
  } catch (e: any) {
    log.warn({ err: e.message }, 'Failed to store job error in Redis');
  }
}

const log = workerLogger.child({ component: 'prompt-job-executor' });

/** Expand leading `~` or `~/` to the user's home directory. */
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return homedir() + p.slice(1);
  return p;
}

function isPathLikeInputKey(inputTypeKey: string): boolean {
  return inputTypeKey === 'path' || inputTypeKey.endsWith('_path') || inputTypeKey.endsWith('_dir');
}

function normalizeJobInputContent(inputTypeKey: string, content: string): string {
  if (!isPathLikeInputKey(inputTypeKey)) return content;

  return path.resolve(expandTilde(content.trim()));
}

/** Max chars per batch for map-reduce splitting. */
const BATCH_CHAR_LIMIT = 50_000;

/** Threshold above which we use map-reduce. */
const MAP_REDUCE_THRESHOLD = 100_000;

/** Timeout per claude -p subprocess (2 minutes). */
const STEP_TIMEOUT_MS = 2 * 60 * 1000;

/** Active job execution tracking (worker pool). */
const activeJobs = new Map<string, { runId: string; child: import('child_process').ChildProcess | null }>();

/** Max concurrent jobs — loaded from settings on init, reloadable. */
let maxConcurrency = 3;

interface JobRow {
  id: string;
  job_type_key: string;
  assistant_id: string;
  assistant_handle: string;
  project_id: string | null;
  definition_id: string | null;
  definition_key: string | null;
}

interface DefinitionStepRow {
  id: string;
  step_index: number;
  key: string;
  name: string;
  step_type: string;
  assistant_handle: string | null;
  model: string | null;
  prompt_handle: string | null;
  input_source: string;
  input_config: Record<string, any>;
  config: Record<string, any>;
  timeout_ms: number;
}

interface JobInputRow {
  id: string;
  input_type_key: string;
  content: string | null;
  ref_type: string | null;
  ref_id: string | null;
}

/** Metadata about the job itself, available as {{job.*}} in templates. */
interface JobMeta {
  model?: string;
  assistant: string;
  /** Input type keys declared with required=false on this definition. */
  optionalInputs: Set<string>;
}

/** Metadata about a completed step, available as {{meta.<step_key>.*}} in templates. */
interface StepMeta {
  backend: string;
  model?: string;
  script?: string;
}

/**
 * Run `claude -p` and return { stdout, stderr, exitCode }.
 */
const DEFAULT_ALLOWED_TOOLS = ['mcp__khef__*', 'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
let cachedAllowedTools: string[] | null = null;

async function getKdagAllowedTools(): Promise<string[]> {
  if (cachedAllowedTools) return cachedAllowedTools;
  try {
    const row = await querySingle<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'kdag.allowedTools'"
    );
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed) && parsed.length > 0) {
        cachedAllowedTools = parsed;
        return cachedAllowedTools;
      }
    }
  } catch { /* use default */ }
  cachedAllowedTools = DEFAULT_ALLOWED_TOOLS;
  return cachedAllowedTools;
}

/** Clear cached allowed tools so next runClaude call re-reads from settings. */
export function invalidateAllowedToolsCache(): void {
  cachedAllowedTools = null;
}

function runClaude(args: {
  promptText: string;
  stdin?: string;
  model?: string;
  outputFormat?: string;
  timeoutMs?: number;
  allowedTools?: string[];
  onChild?: (child: import('child_process').ChildProcess) => void;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const tools = args.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    const cliArgs = [
      '-p', args.promptText,
      '--output-format', args.outputFormat || 'text',
      '--setting-sources', 'user',
      '--no-session-persistence',
      '--allowedTools', tools.join(','),
    ];
    if (args.model) {
      cliArgs.push('--model', args.model);
    }

    log.info({ cliArgs: cliArgs.filter(a => a !== args.promptText) }, 'Spawning claude -p');

    const child = spawn('claude', cliArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    args.onChild?.(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutMs = args.timeoutMs ?? STEP_TIMEOUT_MS;
    let resolved = false;
    const safeResolve = (result: { stdout: string; stderr: string; exitCode: number }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(() => {
      timedOut = true;
      log.warn({ timeoutMs }, 'claude -p timed out, killing process');
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
      // Fallback: if close event never fires (orphaned child processes), force-resolve
      setTimeout(() => {
        safeResolve({ stdout, stderr: `Process timed out after ${timeoutMs}ms (force-resolved)`, exitCode: 124 });
      }, 10000);
    }, timeoutMs);

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (timedOut) {
        safeResolve({ stdout, stderr: `Process timed out after ${timeoutMs}ms`, exitCode: 124 });
      } else {
        safeResolve({ stdout, stderr, exitCode: code ?? 1 });
      }
    });

    child.on('error', (err) => {
      stderr += err.message;
      safeResolve({ stdout, stderr, exitCode: 1 });
    });

    // Pipe stdin content
    if (args.stdin) {
      child.stdin.write(args.stdin);
    }
    child.stdin.end();
  });
}

/**
 * Run `codex exec` and return { stdout, exitCode }.
 * Uses -o to capture clean output, -C /tmp to avoid project instructions,
 * and -c instructions="" to skip user-level AGENTS.md.
 */
function runCodex(args: {
  promptText: string;
  model?: string;
  timeoutMs?: number;
  onChild?: (child: import('child_process').ChildProcess) => void;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const { tmpdir } = require('os');
    const { join } = require('path');
    const { randomUUID } = require('crypto');
    const fs = require('fs');

    const outFile = join(tmpdir(), `codex-out-${randomUUID()}.txt`);
    const cliArgs = [
      'exec',
      '-c', 'instructions=""',
      '-C', '/tmp',
      '--skip-git-repo-check',
      '-o', outFile,
    ];
    if (args.model) {
      cliArgs.push('-m', args.model);
    }
    cliArgs.push(args.promptText);

    log.info({ model: args.model, promptLen: args.promptText.length }, 'Spawning codex exec');

    const child = spawn('codex', cliArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    args.onChild?.(child);

    let stderr = '';
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutMs = args.timeoutMs ?? STEP_TIMEOUT_MS;
    let resolved = false;
    const safeResolve = (result: { stdout: string; stderr: string; exitCode: number }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(() => {
      timedOut = true;
      log.warn({ timeoutMs }, 'codex exec timed out, killing process');
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
      // Fallback: if close event never fires (orphaned child processes), force-resolve
      setTimeout(() => {
        let stdout = '';
        try { stdout = fs.readFileSync(outFile, 'utf-8'); fs.unlinkSync(outFile); } catch {}
        safeResolve({ stdout, stderr: `Process timed out after ${timeoutMs}ms (force-resolved)`, exitCode: 124 });
      }, 10000);
    }, timeoutMs);

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      // Read output from -o file
      let stdout = '';
      try {
        stdout = fs.readFileSync(outFile, 'utf-8');
        fs.unlinkSync(outFile);
      } catch {
        // File may not exist if codex failed before writing
      }

      if (timedOut) {
        safeResolve({ stdout, stderr: `Process timed out after ${timeoutMs}ms`, exitCode: 124 });
      } else {
        safeResolve({ stdout, stderr, exitCode: code ?? 1 });
      }
    });

    child.on('error', (err) => {
      stderr += err.message;
      safeResolve({ stdout: '', stderr, exitCode: 1 });
    });

    child.stdin.end();
  });
}

/**
 * Run a prompt via Gemini (Vertex AI) and return the response text.
 */
async function runGemini(args: {
  promptText: string;
  model?: string;
  useGoogleSearch?: boolean;
  useUrlContext?: boolean;
  useThinking?: boolean;
  thinkingBudget?: number;
  maxRetries?: number;
}): Promise<{ text: string; grounding?: { searchQueries: string[]; sources: Array<{ uri: string; title: string }> }; urlContext?: { fetched: Array<{ url: string; status: string }> }; thinking?: { text: string; tokenCount: number } }> {
  log.info({ model: args.model, promptLen: args.promptText.length, useGoogleSearch: args.useGoogleSearch, useUrlContext: args.useUrlContext, useThinking: args.useThinking }, 'Calling Gemini');
  try {
    const result = await generateContent(args.promptText, {
      model: args.model || undefined,
      useGoogleSearch: args.useGoogleSearch,
      useUrlContext: args.useUrlContext,
      useThinking: args.useThinking,
      thinkingBudget: args.thinkingBudget,
      maxRetries: args.maxRetries,
    });
    return { text: result.response, grounding: result.grounding, urlContext: result.urlContext, thinking: result.thinking };
  } catch (err: any) {
    log.error({ model: args.model, promptLen: args.promptText.length, err: err.message }, 'Gemini call failed');
    throw err;
  }
}

/**
 * Resolve per-phase timeout overrides for a map_reduce step.
 *
 * Both overrides fall back to the step-level timeout. They only apply when
 * fan-out actually happens — the below-threshold single-pass branch in
 * executeDefinitionMapReduce keeps using stepTimeoutMs directly because that
 * call is neither a batch nor a synthesis.
 */
export function resolveMapReduceTimeouts(
  config: Record<string, any> | null | undefined,
  stepTimeoutMs: number
): { batchTimeoutMs: number; synthTimeoutMs: number } {
  const batch = (config?.batch_timeout_ms as number | undefined);
  const synth = (config?.synthesis_timeout_ms as number | undefined);
  return {
    batchTimeoutMs: typeof batch === 'number' ? batch : stepTimeoutMs,
    synthTimeoutMs: typeof synth === 'number' ? synth : stepTimeoutMs,
  };
}

/**
 * Build JSON metadata for a step record (backend, model, timeout, plus extras like grounding).
 */
function buildStepMeta(
  backend: string,
  model: string | undefined,
  timeoutMs: number,
  extra?: Record<string, any>
): string {
  const meta: Record<string, any> = { backend, timeout_ms: timeoutMs };
  if (model) meta.model = model;
  if (extra) Object.assign(meta, extra);
  return JSON.stringify(meta);
}

/**
 * Generic prompt runner that dispatches to Claude, Codex, or Gemini.
 */
interface PromptResult {
  text: string;
  metadata?: Record<string, any>;
}

async function runPrompt(args: {
  promptText: string;
  backend: 'claude' | 'codex' | 'gemini';
  model?: string;
  timeoutMs?: number;
  useGoogleSearch?: boolean;
  useUrlContext?: boolean;
  useThinking?: boolean;
  thinkingBudget?: number;
  maxRetries?: number;
  onChild?: (child: import('child_process').ChildProcess) => void;
}): Promise<PromptResult> {
  if (args.backend === 'gemini') {
    const geminiResult = await runGemini({ promptText: args.promptText, model: args.model, useGoogleSearch: args.useGoogleSearch, useUrlContext: args.useUrlContext, useThinking: args.useThinking, thinkingBudget: args.thinkingBudget, maxRetries: args.maxRetries });
    const text = geminiResult.text.trim();
    if (!text) {
      // generateContent should already throw for empty responses, but guard anyway
      throw new Error(`Gemini returned empty output (model=${args.model || 'default'})`);
    }
    const metadata: Record<string, any> = {};
    if (geminiResult.grounding) metadata.grounding = geminiResult.grounding;
    if (geminiResult.urlContext) metadata.url_context = geminiResult.urlContext;
    if (geminiResult.thinking) metadata.thinking = geminiResult.thinking;
    return { text, ...(Object.keys(metadata).length > 0 && { metadata }) };
  }
  if (args.backend === 'codex') {
    const result = await runCodex({
      promptText: args.promptText,
      model: args.model,
      timeoutMs: args.timeoutMs,
      onChild: args.onChild,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `codex exited with code ${result.exitCode}`);
    }
    const text = result.stdout.trim();
    if (!text) {
      throw new Error('Step returned empty output');
    }
    return { text };
  }
  // Default: Claude
  const allowedTools = await getKdagAllowedTools();
  const result = await runClaude({
    promptText: args.promptText,
    model: args.model,
    outputFormat: 'text',
    timeoutMs: args.timeoutMs,
    allowedTools,
    onChild: args.onChild,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `claude exited with code ${result.exitCode}`);
  }
  const text = result.stdout.trim();
  if (!text) {
    throw new Error('Step returned empty output');
  }
  // Build command signature for debugging (prompt replaced with placeholder)
  const cmdParts = ['claude', '-p', '{{prompt}}', '--output-format', 'text', '--setting-sources', 'user', '--no-session-persistence', '--allowedTools', allowedTools.join(',')];
  if (args.model) cmdParts.push('--model', args.model);
  return { text, metadata: { allowed_tools: allowedTools, command: cmdParts.join(' ') } };
}

/**
 * Run a code script as a subprocess.
 * The script receives input via stdin and writes output to stdout.
 * Uses `tsx` for .ts/.tsx files, `python3` for .py files, and `node` otherwise.
 */
export function resolveCodeStepRuntime(scriptPath: string): { command: string; args: string[] } {
  const normalized = scriptPath.toLowerCase();
  if (normalized.endsWith('.ts') || normalized.endsWith('.tsx')) {
    return { command: 'tsx', args: [scriptPath] };
  }
  if (normalized.endsWith('.py')) {
    return { command: 'python3', args: [scriptPath] };
  }
  return { command: 'node', args: [scriptPath] };
}

function runCode(args: {
  scriptPath: string;
  input: string;
  cwd?: string;
  timeoutMs?: number;
  onChild?: (child: import('child_process').ChildProcess) => void;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const runtime = resolveCodeStepRuntime(args.scriptPath);
    const command = runtime.command;

    log.info({ command, scriptPath: args.scriptPath, inputLen: args.input.length, cwd: args.cwd }, `Spawning ${command} for code step`);

    const child = spawn(command, runtime.args, {
      cwd: args.cwd ? expandTilde(args.cwd) : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    args.onChild?.(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutMs = args.timeoutMs ?? STEP_TIMEOUT_MS;
    let resolved = false;
    const safeResolve = (result: { stdout: string; stderr: string; exitCode: number }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(() => {
      timedOut = true;
      log.warn({ scriptPath: args.scriptPath, timeoutMs }, 'Code step timed out, killing process');
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
      setTimeout(() => {
        safeResolve({ stdout, stderr: `Process timed out after ${timeoutMs}ms (force-resolved)`, exitCode: 124 });
      }, 10000);
    }, timeoutMs);

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (timedOut) {
        safeResolve({ stdout, stderr: `Process timed out after ${timeoutMs}ms`, exitCode: 124 });
      } else {
        safeResolve({ stdout, stderr, exitCode: code ?? 1 });
      }
    });

    child.on('error', (err) => {
      stderr += err.message;
      safeResolve({ stdout: '', stderr, exitCode: 1 });
    });

    // Pipe input via stdin
    child.stdin.write(args.input);
    child.stdin.end();
  });
}

/**
 * Split content into batches of roughly BATCH_CHAR_LIMIT chars.
 * Splits on double-newline boundaries to avoid breaking mid-message.
 */
function splitIntoBatches(content: string, chunkSize?: number): string[] {
  const limit = chunkSize || BATCH_CHAR_LIMIT;
  const batches: string[] = [];
  const segments = content.split('\n\n');
  let current = '';

  for (const segment of segments) {
    if (current.length + segment.length + 2 > limit && current.length > 0) {
      batches.push(current);
      current = segment;
    } else {
      current += (current ? '\n\n' : '') + segment;
    }
  }

  if (current) {
    batches.push(current);
  }

  return batches;
}

/**
 * Split CSV content into batches of rows, preserving the header in each batch.
 * Uses papaparse for robust CSV parsing (handles quoted fields, embedded newlines, auto-detected delimiters).
 */
function splitCsvRows(content: string, batchSize?: number): string[] {
  const size = batchSize ?? 1;
  const result = Papa.parse<string[]>(content.trim(), {
    header: false,
    skipEmptyLines: true,
    dynamicTyping: false,
  });

  const data = result.data;
  if (data.length <= 1) {
    // No data rows (only header or empty) — return as single batch
    return [content.trim()];
  }

  const headers = data[0];
  const rows = data.slice(1);
  const delimiter = result.meta.delimiter;
  const batches: string[] = [];

  for (let i = 0; i < rows.length; i += size) {
    const batch = rows.slice(i, i + size);
    batches.push(Papa.unparse({ fields: headers, data: batch }, { delimiter }));
  }

  return batches;
}

/**
 * Split content into batches by line boundaries.
 * Each batch contains `batchSize` lines (default: 1). Empty lines are skipped.
 */
function splitByLine(content: string, batchSize?: number): string[] {
  const size = batchSize ?? 1;
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return [content];

  const batches: string[] = [];
  for (let i = 0; i < lines.length; i += size) {
    batches.push(lines.slice(i, i + size).join('\n'));
  }
  return batches;
}

/**
 * Execute a job. This is the main entry point.
 *
 * - Creates a job_run with status 'running'
 * - Reads inputs from job_inputs
 * - For small input: single claude -p call
 * - For large input: map-reduce with checkpointed steps
 * - On success: stores output in job_outputs, updates session_summaries if applicable
 * - On failure: marks run as 'failed' (steps preserve progress)
 */
export async function executeJob(jobId: string, opts?: { model?: string; cliFlags?: Record<string, unknown>; stepTimeoutMs?: number; batchDelayMs?: number; existingRunId?: string }): Promise<string> {
  // Load job with type key and assistant handle
  const job = await querySingle<JobRow>(
    `SELECT j.id, jt.key as job_type_key, j.assistant_id, a.handle as assistant_handle, j.project_id, j.definition_id, jd.key as definition_key
     FROM kdag.jobs j
     JOIN kdag.job_types jt ON jt.id = j.job_type_id
     JOIN assistants a ON a.id = j.assistant_id
     LEFT JOIN kdag.job_definitions jd ON jd.id = j.definition_id
     WHERE j.id = $1`,
    [jobId]
  );

  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  // Load inputs
  const inputs = await query<JobInputRow>(
    `SELECT ji.id, it.key as input_type_key, ji.content, ji.ref_type, ji.ref_id
     FROM kdag.job_inputs ji
     JOIN kdag.input_types it ON it.id = ji.input_type_id
     WHERE ji.job_id = $1`,
    [jobId]
  );

  // Create a new run or reuse a queued one
  let runId: string;
  if (opts?.existingRunId) {
    await query(
      "UPDATE kdag.job_runs SET status = 'running', started_at = NOW(), model = COALESCE($2, model), cli_flags = COALESCE($3, cli_flags) WHERE id = $1",
      [opts.existingRunId, opts?.model || null, opts?.cliFlags ? JSON.stringify(opts.cliFlags) : null]
    );
    runId = opts.existingRunId;
  } else {
    const run = await querySingle<{ id: string }>(
      `INSERT INTO kdag.job_runs (job_id, status, model, cli_flags, started_at)
       VALUES ($1, 'running', $2, $3, NOW())
       RETURNING id`,
      [jobId, opts?.model || null, opts?.cliFlags ? JSON.stringify(opts.cliFlags) : null]
    );
    runId = run!.id;
  }

  // Register in worker pool
  activeJobs.set(jobId, { runId, child: null });
  const onChild = (child: import('child_process').ChildProcess) => {
    const entry = activeJobs.get(jobId);
    if (entry) entry.child = child;
  };
  const startTime = Date.now();

  try {
    // Resolve project working directory
    let cwd: string | undefined;
    if (job.project_id) {
      const project = await querySingle<{ path: string | null }>(
        'SELECT path FROM projects WHERE id = $1',
        [job.project_id]
      );
      if (project?.path) {
        cwd = project.path;
      }
    }

    let finalOutput: string;

    if (job.definition_id) {
      // Definition-driven execution
      finalOutput = await executeDefinitionJob(runId, job, inputs, cwd, opts, undefined, onChild);
    } else {
      // Legacy execution (no definition)
      finalOutput = await executeLegacyJob(runId, job, inputs, opts, onChild);
    }

    const durationMs = Date.now() - startTime;

    // Resolve output format ID
    const textFormat = await querySingle<{ id: number }>(
      "SELECT id FROM kdag.output_formats WHERE key = 'text'",
      []
    );

    // Store output
    await query(
      `INSERT INTO kdag.job_outputs (job_run_id, output_format_id, output_text) VALUES ($1, $2, $3)`,
      [runId, textFormat!.id, finalOutput]
    );

    // Mark run completed
    await query(
      'UPDATE kdag.job_runs SET status = $1, exit_code = 0, duration_ms = $2, completed_at = NOW() WHERE id = $3',
      ['completed', durationMs, runId]
    );

    // For session_summary jobs, upsert session summary
    const transcriptInput = inputs.find(i => i.input_type_key === 'transcript');
    if (job.job_type_key === 'session_summary' && transcriptInput?.ref_type === 'session' && transcriptInput.ref_id) {
      const newSnapshotId = await upsertSessionSummary(transcriptInput.ref_id, runId, finalOutput);
      if (job.definition_key === 'consolidate-session-summaries') {
        try {
          await trashOldSessionSnapshots(transcriptInput.ref_id, newSnapshotId);
        } catch (err: any) {
          log.error({ err: err.message, sessionId: transcriptInput.ref_id }, 'Failed to trash old snapshots after consolidation');
        }
      }
    }

    log.info({ jobId, runId, durationMs, outputLen: finalOutput.length }, 'Job run completed');
    return runId;
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    log.error({ jobId, runId, err: err.message, durationMs }, 'Job run failed');

    await query(
      'UPDATE kdag.job_runs SET status = $1, error = $2, exit_code = $3, duration_ms = $4, completed_at = NOW() WHERE id = $5',
      ['failed', err.message, 1, durationMs, runId]
    );

    // Cancel remaining pending steps so they don't stay orphaned
    await query(
      "UPDATE kdag.job_steps SET status = 'canceled' WHERE job_run_id = $1 AND status = 'pending'",
      [runId]
    );

    await recordJobError(jobId, runId, job.definition_id, job.job_type_key, err.message, durationMs);

    throw err;
  } finally {
    activeJobs.delete(jobId);
    processQueue().catch(err => log.error({ err: err.message }, 'Error processing queue after job'));
  }
}

/**
 * Legacy execution path for jobs without a definition.
 * Preserves the original hardcoded map-reduce / single-call logic.
 */
async function executeLegacyJob(
  runId: string,
  job: JobRow,
  inputs: JobInputRow[],
  opts?: { model?: string; stepTimeoutMs?: number },
  onChild?: (child: import('child_process').ChildProcess) => void
): Promise<string> {
  const promptInput = inputs.find(i => i.input_type_key === 'prompt');
  const chunkPromptInput = inputs.find(i => i.input_type_key === 'chunk_prompt');
  const transcriptInput = inputs.find(i => i.input_type_key === 'transcript');
  const existingSummaryInput = inputs.find(i => i.input_type_key === 'existing_summary');

  if (!promptInput?.content) {
    throw new Error(`Job ${job.id} has no prompt input`);
  }

  const inputContext = transcriptInput?.content || null;
  const inputLen = inputContext?.length ?? 0;
  const backend = resolveBackend(job.assistant_handle);

  if (inputLen > MAP_REDUCE_THRESHOLD) {
    if (!chunkPromptInput?.content) {
      throw new Error(`Job ${job.id} requires a chunk_prompt input for map-reduce`);
    }
    return executeMapReduce(runId, promptInput.content, chunkPromptInput.content, inputContext!, backend, opts?.model, false, opts?.stepTimeoutMs, undefined, onChild);
  }

  let promptWithContext = promptInput.content;
  if (existingSummaryInput?.content) {
    promptWithContext += `\n\n---\n\nExisting summary:\n\n${existingSummaryInput.content}`;
  }
  if (inputContext) {
    promptWithContext += `\n\n---\n\nSession transcript:\n\n${inputContext}`;
  }

  const result = await runPrompt({
    promptText: promptWithContext,
    backend,
    model: opts?.model || undefined,
    timeoutMs: opts?.stepTimeoutMs,
    onChild,
  });
  return result.text;
}

/** Resolve assistant handle to backend type. */
function resolveBackend(assistantHandle: string): 'claude' | 'codex' | 'gemini' {
  if (assistantHandle === 'gemini') return 'gemini';
  if (assistantHandle === 'codex-cli') return 'codex';
  return 'claude';
}

/**
 * Resolve input for a definition step based on input_source and input_config.
 *
 * Template placeholders:
 *   {{job_input.TYPE}}        — value of a declared job input
 *   {{step.KEY}}              — output of a prior step
 *   {{job.model}}             — run-level model
 *   {{job.assistant}}         — job assistant handle
 *   {{meta.KEY.backend}}      — backend that ran a prior step
 *   {{meta.KEY.model}}        — model used by a prior step
 *   {{meta.KEY.script}}       — script path for a prior code step
 */
function resolveStepInput(
  step: DefinitionStepRow,
  jobInputs: JobInputRow[],
  stepOutputs: Map<string, string>,
  jobMeta: JobMeta,
  stepMeta: Map<string, StepMeta>
): string {
  const { input_source, input_config } = step;

  if (input_source === 'job_input') {
    const inputTypeKey = input_config.input_type as string;
    const jobInput = jobInputs.find(i => i.input_type_key === inputTypeKey);
    if (!jobInput?.content) {
      if (jobMeta.optionalInputs.has(inputTypeKey)) {
        return '';
      }
      throw new Error(`Step '${step.key}': missing job input '${inputTypeKey}'`);
    }
    return normalizeJobInputContent(inputTypeKey, jobInput.content);
  }

  if (input_source === 'previous_step') {
    const stepKey = input_config.step_key as string;
    const output = stepOutputs.get(stepKey);
    if (output === undefined) {
      throw new Error(`Step '${step.key}': no output from step '${stepKey}'`);
    }
    return output;
  }

  if (input_source === 'template') {
    const template = input_config.template as string;
    if (!template) {
      throw new Error(`Step '${step.key}': template input_source requires a template string`);
    }
    // Replace {{job_input.TYPE}}, {{step.KEY}}, {{job.FIELD}}, {{meta.KEY.FIELD}} placeholders
    return template.replace(
      /\{\{(job_input|step|job|meta)\.([^}.]+)(?:\.([^}]+))?\}\}/g,
      (_match, ns, key, field) => {
        if (ns === 'job_input') {
          const jobInput = jobInputs.find(i => i.input_type_key === key);
          return jobInput?.content ? normalizeJobInputContent(key, jobInput.content) : '';
        }
        if (ns === 'step') {
          return stepOutputs.get(key) || '';
        }
        if (ns === 'job') {
          if (key === 'model') return jobMeta.model || '';
          if (key === 'assistant') return jobMeta.assistant;
          return '';
        }
        if (ns === 'meta') {
          const meta = stepMeta.get(key);
          if (!meta) return '';
          if (field === 'backend') return meta.backend;
          if (field === 'model') return meta.model || '';
          if (field === 'script') return meta.script || '';
          return '';
        }
        return '';
      }
    );
  }

  throw new Error(`Step '${step.key}': unknown input_source '${input_source}'`);
}

/**
 * Definition-driven job execution.
 * Reads step definitions, executes each in order, passes outputs forward.
 */
async function executeDefinitionJob(
  runId: string,
  job: JobRow,
  jobInputs: JobInputRow[],
  cwd: string | undefined,
  opts?: { model?: string; stepTimeoutMs?: number; batchDelayMs?: number },
  resuming?: boolean,
  onChild?: (child: import('child_process').ChildProcess) => void
): Promise<string> {
  // Load definition steps
  const defSteps = await query<DefinitionStepRow>(
    `SELECT id, step_index, key, name, step_type, assistant_handle, model,
            prompt_handle, input_source, input_config, config, timeout_ms
     FROM kdag.job_definition_steps
     WHERE definition_id = $1
     ORDER BY step_index`,
    [job.definition_id!]
  );

  if (defSteps.length === 0) {
    throw new Error(`Definition for job ${job.id} has no steps`);
  }

  const stepOutputs = new Map<string, string>();
  const stepMeta = new Map<string, StepMeta>();

  // Resolve which declared inputs are optional so resolveStepInput can pass an
  // empty string to steps that depend on a job_input the user omitted.
  const optionalInputs = new Set<string>();
  if (job.definition_id) {
    const declared = await query<{ input_type_key: string; required: boolean }>(
      `SELECT it.key as input_type_key, jdi.required
       FROM kdag.job_definition_inputs jdi
       JOIN kdag.input_types it ON it.id = jdi.input_type_id
       WHERE jdi.definition_id = $1`,
      [job.definition_id]
    );
    for (const row of declared) {
      if (!row.required) optionalInputs.add(row.input_type_key);
    }
  }

  const jobMeta: JobMeta = { model: opts?.model, assistant: job.assistant_handle, optionalInputs };
  let lastOutput = '';

  // On retry, load outputs from previously completed steps so we can skip them
  if (resuming) {
    const completedJobSteps = await query<{ definition_step_index: number; step_index: number; step_type: string; output_text: string; metadata: Record<string, any> | null }>(
      "SELECT definition_step_index, step_index, step_type, output_text, metadata FROM kdag.job_steps WHERE job_run_id = $1 AND status = 'completed'",
      [runId]
    );

    for (const defStep of defSteps) {
      let output: string | undefined;
      let meta: Record<string, any> | null = null;
      if (defStep.step_type === 'map_reduce') {
        // Map-reduce is complete only if its synthesis step finished
        const synthStep = completedJobSteps.find(
          s => s.step_type === 'synthesis' && s.definition_step_index === defStep.step_index
        );
        output = synthStep?.output_text;
        meta = synthStep?.metadata ?? null;
      } else {
        const step = completedJobSteps.find(s => s.definition_step_index === defStep.step_index && s.step_index === 0);
        output = step?.output_text;
        meta = step?.metadata ?? null;
      }

      if (output) {
        stepOutputs.set(defStep.key, output);
        lastOutput = output;
        // Reconstruct step metadata from the stored jsonb
        if (meta) {
          stepMeta.set(defStep.key, {
            backend: meta.backend || (defStep.step_type === 'code' ? 'code' : 'unknown'),
            model: meta.model,
            script: defStep.config?.script_path as string | undefined,
          });
        }
      }
    }

    // Clean up non-completed map-reduce sub-steps for steps that will be re-executed
    // Keep completed batch outputs so executeDefinitionMapReduce can skip them
    for (const defStep of defSteps) {
      if (defStep.step_type === 'map_reduce' && !stepOutputs.has(defStep.key)) {
        await query(
          "DELETE FROM kdag.job_steps WHERE job_run_id = $1 AND definition_step_index = $2 AND status != 'completed'",
          [runId, defStep.step_index]
        );
      }
    }

    const skipped = stepOutputs.size;
    if (skipped > 0) {
      log.info({ runId, skipped, total: defSteps.length }, 'Resuming from completed steps');
    }
  }

  for (const defStep of defSteps) {
    // Skip already-completed steps (retry resume)
    if (stepOutputs.has(defStep.key)) {
      lastOutput = stepOutputs.get(defStep.key)!;
      log.info({ runId, step: defStep.key, stepIndex: defStep.step_index }, 'Skipping completed step (retry)');
      continue;
    }
    const backend = resolveBackend(defStep.assistant_handle || job.assistant_handle);
    const stepModel = defStep.model || opts?.model || undefined;
    const timeoutMs = opts?.stepTimeoutMs || defStep.timeout_ms || STEP_TIMEOUT_MS;

    if (defStep.step_type === 'code') {
      // 'code' step — execute a script file as a subprocess
      const rawScriptPath = defStep.config?.script_path as string;
      if (!rawScriptPath) {
        throw new Error(`Step '${defStep.key}': code step requires config.script_path`);
      }

      // Resolve script path: try project cwd, API cwd, then monorepo root.
      // The API runs from apps/api/, so monorepo root is two levels up.
      // This supports project-local scripts and system definition scripts.
      const repoRoot = path.resolve(process.cwd(), '..', '..');
      let scriptPath: string;
      if (path.isAbsolute(rawScriptPath)) {
        scriptPath = rawScriptPath;
      } else {
        const candidates = [
          cwd ? path.resolve(cwd, rawScriptPath) : null,
          path.resolve(process.cwd(), rawScriptPath),
          path.resolve(repoRoot, rawScriptPath),
        ].filter((p): p is string => p !== null);
        scriptPath = candidates.find(p => fs.existsSync(p)) || candidates[0];
      }

      const inputText = resolveStepInput(defStep, jobInputs, stepOutputs, jobMeta, stepMeta);

      await query(
        `INSERT INTO kdag.job_steps (job_run_id, definition_step_index, step_index, step_type, status, input_chars, input_text)
         VALUES ($1, $2, 0, $3, 'running', $4, $5)`,
        [runId, defStep.step_index, defStep.key, inputText.length, inputText]
      );

      const stepStart = Date.now();
      try {
        const result = await runCode({
          scriptPath,
          input: inputText,
          cwd,
          timeoutMs,
          onChild,
        });
        if (result.exitCode !== 0) {
          throw new Error(result.stderr || `Script exited with code ${result.exitCode}`);
        }
        lastOutput = result.stdout.trim();
        if (!lastOutput) {
          throw new Error('Code step returned empty output');
        }

        const stepDuration = Date.now() - stepStart;
        const runtime = resolveCodeStepRuntime(scriptPath);
        const codeCommand = [runtime.command, ...runtime.args].join(' ') + ' <<< {{input}}';
        const codeMeta = buildStepMeta('code', undefined, timeoutMs, { command: codeCommand, script: scriptPath });
        await query(
          'UPDATE kdag.job_steps SET status = $1, output_text = $2, duration_ms = $3, metadata = $4 WHERE job_run_id = $5 AND definition_step_index = $6 AND step_index = 0',
          ['completed', lastOutput, stepDuration, codeMeta, runId, defStep.step_index]
        );
        stepMeta.set(defStep.key, { backend: 'code', script: scriptPath });
      } catch (err: any) {
        const stepDuration = Date.now() - stepStart;
        const codeMeta = buildStepMeta('code', undefined, timeoutMs, { error: err.message });
        await query(
          'UPDATE kdag.job_steps SET status = $1, output_text = $2, duration_ms = $3, metadata = $4 WHERE job_run_id = $5 AND definition_step_index = $6 AND step_index = 0',
          ['failed', err.message, stepDuration, codeMeta, runId, defStep.step_index]
        );
        throw new Error(`Step '${defStep.key}' failed: ${err.message}`);
      }

      log.info({ runId, step: defStep.key, stepIndex: defStep.step_index, durationMs: Date.now() - stepStart }, 'Code step completed');
    } else {
      // 'prompt' or 'map_reduce' step — resolve prompt text
      let promptText: string;
      if (defStep.prompt_handle) {
        const promptRow = await querySingle<{ content: string }>(
          'SELECT content FROM prompts WHERE handle = $1',
          [defStep.prompt_handle]
        );
        if (!promptRow) {
          throw new Error(`Step '${defStep.key}': prompt '${defStep.prompt_handle}' not found`);
        }
        promptText = promptRow.content;
      } else {
        const promptInput = jobInputs.find(i => i.input_type_key === 'prompt');
        if (!promptInput?.content) {
          throw new Error(`Step '${defStep.key}': no prompt_handle and no prompt job input`);
        }
        promptText = promptInput.content;
      }

      if (defStep.step_type === 'map_reduce') {
        lastOutput = await executeDefinitionMapReduce(
          runId, defStep, promptText, jobInputs, stepOutputs, jobMeta, stepMeta, backend, stepModel, timeoutMs, opts?.batchDelayMs, resuming, onChild
        );
        stepMeta.set(defStep.key, { backend, model: stepModel });
      } else {
        // 'prompt' step — single LLM call
        const inputText = resolveStepInput(defStep, jobInputs, stepOutputs, jobMeta, stepMeta);
        let fullPrompt: string;
        if (inputText === promptText) {
          fullPrompt = promptText;
        } else {
          const inputTag = defStep.input_source === 'previous_step'
            ? `previous_step_output step="${(defStep.input_config as any).step_key}"`
            : defStep.input_source === 'job_input'
              ? `job_input type="${(defStep.input_config as any).input_type}"`
              : 'input';
          const closingTag = inputTag.split(' ')[0];
          fullPrompt = `${promptText}\n\n<${inputTag}>\n${inputText}\n</${closingTag}>`;
        }

        await query(
          `INSERT INTO kdag.job_steps (job_run_id, definition_step_index, step_index, step_type, status, input_chars, input_text)
           VALUES ($1, $2, 0, $3, 'running', $4, $5)`,
          [runId, defStep.step_index, defStep.key, fullPrompt.length, fullPrompt]
        );

        const stepStart = Date.now();
        try {
          const promptResult = await runPrompt({
            promptText: fullPrompt,
            backend,
            model: stepModel,
            timeoutMs,
            useGoogleSearch: backend === 'gemini' && !!defStep.config?.use_google_search,
            useUrlContext: backend === 'gemini' && !!defStep.config?.use_url_context,
            useThinking: backend === 'gemini' && !!defStep.config?.use_thinking,
            thinkingBudget: backend === 'gemini' && defStep.config?.thinking_budget != null ? defStep.config.thinking_budget as number : undefined,
            maxRetries: backend === 'gemini' && defStep.config?.max_retries != null ? defStep.config.max_retries as number : undefined,
            onChild,
          });
          lastOutput = promptResult.text;

          const stepDuration = Date.now() - stepStart;
          const dbMeta = buildStepMeta(backend, stepModel, timeoutMs, promptResult.metadata);
          await query(
            'UPDATE kdag.job_steps SET status = $1, output_text = $2, duration_ms = $3, metadata = $4 WHERE job_run_id = $5 AND definition_step_index = $6 AND step_index = 0',
            ['completed', lastOutput, stepDuration, dbMeta, runId, defStep.step_index]
          );
          stepMeta.set(defStep.key, { backend, model: stepModel });
        } catch (err: any) {
          const stepDuration = Date.now() - stepStart;
          const dbMeta = buildStepMeta(backend, stepModel, timeoutMs, { error: err.message });
          await query(
            'UPDATE kdag.job_steps SET status = $1, output_text = $2, duration_ms = $3, metadata = $4 WHERE job_run_id = $5 AND definition_step_index = $6 AND step_index = 0',
            ['failed', err.message, stepDuration, dbMeta, runId, defStep.step_index]
          );
          throw new Error(`Step '${defStep.key}' failed: ${err.message}`);
        }

        log.info({ runId, step: defStep.key, stepIndex: defStep.step_index, durationMs: Date.now() - stepStart }, 'Definition step completed');
      }
    }

    stepOutputs.set(defStep.key, lastOutput);
  }

  return lastOutput;
}

/**
 * Execute a map_reduce definition step.
 * Uses the step's config for chunk_size, threshold, batch prompt, and merge template.
 */
async function executeDefinitionMapReduce(
  runId: string,
  defStep: DefinitionStepRow,
  synthesisPromptText: string,
  jobInputs: JobInputRow[],
  stepOutputs: Map<string, string>,
  jobMeta: JobMeta,
  stepMeta: Map<string, StepMeta>,
  backend: 'claude' | 'codex' | 'gemini',
  model: string | undefined,
  timeoutMs: number,
  runtimeBatchDelayMs?: number,
  resuming?: boolean,
  onChild?: (child: import('child_process').ChildProcess) => void
): Promise<string> {
  const config = defStep.config;
  const chunkSize = (config.chunk_size as number) || BATCH_CHAR_LIMIT;
  const threshold = (config.threshold as number) ?? MAP_REDUCE_THRESHOLD;
  const splitMode = config.split_mode as string | undefined;
  const batchSizeRows = config.batch_size as number | undefined;
  const batchPromptHandle = config.batch_prompt_handle as string | undefined;
  const singlePromptHandle = config.single_prompt_handle as string | undefined;
  const updatePromptHandle = config.update_prompt_handle as string | undefined;
  const includeGeneratedAt = !!config.include_generated_at;
  const mergeTemplate = (config.merge_template as string) || '## Segment {{index}}\n\n{{output}}';

  // Per-phase timeout overrides. Both fall back to the step-level timeoutMs
  // (which is itself the resolved value of opts.stepTimeoutMs || defStep.timeout_ms
  // || STEP_TIMEOUT_MS). These only take effect when fan-out happens — the
  // below-threshold single-pass branch keeps using the step-level timeoutMs since
  // it is neither a batch nor a synthesis call.
  const { batchTimeoutMs, synthTimeoutMs } = resolveMapReduceTimeouts(config, timeoutMs);

  // If an `existing_summary` job_input is present, splice it as context into the
  // single-pass and synthesis prompts. Used for incremental session summaries:
  // the transcript contains only new chunks and the previous summary is injected
  // as context so the LLM can continue from it rather than summarize standalone.
  const existingSummaryInput = jobInputs.find(i => i.input_type_key === 'existing_summary');
  const hasExistingSummary = !!existingSummaryInput?.content;
  const previousSummaryBlock = hasExistingSummary
    ? `<previous_summary>\n${existingSummaryInput!.content}\n</previous_summary>\n\n`
    : '';

  // Optional generation timestamp block — when a step opts in via
  // config.include_generated_at, the LLM receives the current UTC timestamp so
  // it can stamp the summary with the time of generation.
  const generatedAtBlock = includeGeneratedAt
    ? `<generated_at>${new Date().toISOString()}</generated_at>\n\n`
    : '';
  const batchDelayMs = runtimeBatchDelayMs ?? ((config.batch_delay_ms as number) || 0);
  const useGoogleSearch = backend === 'gemini' && !!config?.use_google_search;
  const useUrlContext = backend === 'gemini' && !!config?.use_url_context;
  const useThinking = backend === 'gemini' && !!config?.use_thinking;
  const thinkingBudget = backend === 'gemini' && config?.thinking_budget != null ? config.thinking_budget as number : undefined;
  const maxRetries = backend === 'gemini' && config?.max_retries != null ? config.max_retries as number : undefined;

  // Resolve input content
  const inputContent = resolveStepInput(defStep, jobInputs, stepOutputs, jobMeta, stepMeta);

  // If below threshold, run as single prompt call (no fan-out)
  if (inputContent.length <= threshold) {
    // When existing_summary is present and an update prompt is configured,
    // prefer the update prompt over the single-pass prompt.
    // Otherwise use the single-session prompt if configured,
    // otherwise fall back to synthesis prompt.
    const preferredHandle = hasExistingSummary && updatePromptHandle
      ? updatePromptHandle
      : singlePromptHandle;
    let singlePromptText = synthesisPromptText;
    if (preferredHandle) {
      const singlePromptRow = await querySingle<{ content: string }>(
        'SELECT content FROM prompts WHERE handle = $1',
        [preferredHandle]
      );
      if (singlePromptRow) {
        singlePromptText = singlePromptRow.content;
      }
    }
    const fullPrompt = `${singlePromptText}\n\n${generatedAtBlock}${previousSummaryBlock}<transcript>\n${inputContent}\n</transcript>`;

    await query(
      `INSERT INTO kdag.job_steps (job_run_id, definition_step_index, step_index, step_type, status, input_chars, input_text)
       VALUES ($1, $2, 0, $3, 'running', $4, $5)`,
      [runId, defStep.step_index, defStep.key, fullPrompt.length, fullPrompt]
    );

    const stepStart = Date.now();
    const promptResult = await runPrompt({
      promptText: fullPrompt,
      backend,
      model: model || undefined,
      timeoutMs,
      useGoogleSearch,
      useUrlContext,
      useThinking,
      thinkingBudget,
      maxRetries,
      onChild,
    });

    const stepDuration = Date.now() - stepStart;
    const stepMeta = buildStepMeta(backend, model, timeoutMs, promptResult.metadata);
    await query(
      'UPDATE kdag.job_steps SET status = $1, output_text = $2, duration_ms = $3, metadata = $4 WHERE job_run_id = $5 AND definition_step_index = $6 AND step_index = 0',
      ['completed', promptResult.text, stepDuration, stepMeta, runId, defStep.step_index]
    );

    log.info({ runId, step: defStep.key, mode: 'single', durationMs: stepDuration }, 'Map-reduce step completed (below threshold)');
    return promptResult.text;
  }

  // Resolve batch prompt
  let batchPromptText: string;
  if (batchPromptHandle) {
    const batchPromptRow = await querySingle<{ content: string }>(
      'SELECT content FROM prompts WHERE handle = $1',
      [batchPromptHandle]
    );
    if (!batchPromptRow) {
      throw new Error(`Step '${defStep.key}': batch prompt '${batchPromptHandle}' not found`);
    }
    batchPromptText = batchPromptRow.content;
  } else {
    // Fall back to chunk_prompt job input (backward compat)
    const chunkPromptInput = jobInputs.find(i => i.input_type_key === 'chunk_prompt');
    if (!chunkPromptInput?.content) {
      throw new Error(`Step '${defStep.key}': no batch_prompt_handle in config and no chunk_prompt job input`);
    }
    batchPromptText = chunkPromptInput.content;
  }

  // Fan-out: split into batches
  const batches = splitMode === 'csv_row'
    ? splitCsvRows(inputContent, batchSizeRows)
    : splitMode === 'line'
      ? splitByLine(inputContent, batchSizeRows)
      : splitIntoBatches(inputContent, chunkSize);

  // definition_step_index is defStep.step_index; step_index is the local batch index
  const defStepIdx = defStep.step_index;

  // On resume, load completed batch outputs so we can skip them
  const completedBatchOutputs = new Map<number, string>();
  if (resuming) {
    const completedSteps = await query<{ step_index: number; output_text: string }>(
      "SELECT step_index, output_text FROM kdag.job_steps WHERE job_run_id = $1 AND definition_step_index = $2 AND step_type = 'batch_summary' AND status = 'completed' ORDER BY step_index",
      [runId, defStepIdx]
    );
    for (const s of completedSteps) {
      completedBatchOutputs.set(s.step_index, s.output_text);
    }
    if (completedBatchOutputs.size > 0) {
      log.info({ runId, step: defStep.key, skipped: completedBatchOutputs.size, total: batches.length }, 'Resuming map_reduce from completed batch steps');
    }
  }

  // Create step rows only for batches that don't already have completed rows
  const dbClient = await getClient();
  try {
    await dbClient.query('BEGIN');
    for (let i = 0; i < batches.length; i++) {
      if (completedBatchOutputs.has(i)) continue;
      const batchInput = `${batchPromptText}\n\n<transcript>\n${batches[i]}\n</transcript>`;
      await dbClient.query(
        'INSERT INTO kdag.job_steps (job_run_id, definition_step_index, step_index, step_type, input_chars, input_text) VALUES ($1, $2, $3, $4, $5, $6)',
        [runId, defStepIdx, i, 'batch_summary', batches[i].length, batchInput]
      );
    }
    // Only create synthesis step if it doesn't already exist
    const synthLocalIdx = batches.length;
    if (!resuming) {
      await dbClient.query(
        'INSERT INTO kdag.job_steps (job_run_id, definition_step_index, step_index, step_type) VALUES ($1, $2, $3, $4)',
        [runId, defStepIdx, synthLocalIdx, 'synthesis']
      );
    } else {
      // Ensure synthesis step exists (may have been deleted in cleanup)
      const synthExists = await dbClient.query(
        'SELECT 1 FROM kdag.job_steps WHERE job_run_id = $1 AND definition_step_index = $2 AND step_index = $3',
        [runId, defStepIdx, synthLocalIdx]
      );
      if (synthExists.rows.length === 0) {
        await dbClient.query(
          'INSERT INTO kdag.job_steps (job_run_id, definition_step_index, step_index, step_type) VALUES ($1, $2, $3, $4)',
          [runId, defStepIdx, synthLocalIdx, 'synthesis']
        );
      }
    }
    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }

  // Execute batch steps, skipping completed ones
  for (let i = 0; i < batches.length; i++) {
    if (completedBatchOutputs.has(i)) {
      log.info({ runId, step: defStep.key, batch: i, total: batches.length }, 'Skipping completed batch step (retry)');
      continue;
    }

    const batchPrompt = `${batchPromptText}\n\n<transcript>\n${batches[i]}\n</transcript>`;

    await query(
      'UPDATE kdag.job_steps SET status = $1 WHERE job_run_id = $2 AND definition_step_index = $3 AND step_index = $4',
      ['running', runId, defStepIdx, i]
    );

    const stepStart = Date.now();
    try {
      const promptResult = await runPrompt({
        promptText: batchPrompt,
        backend,
        model: model || undefined,
        timeoutMs: batchTimeoutMs,
        useGoogleSearch,
        useThinking,
        thinkingBudget,
        maxRetries,
        onChild,
      });

      const stepDuration = Date.now() - stepStart;
      const batchMeta = buildStepMeta(backend, model, batchTimeoutMs, promptResult.metadata);
      await query(
        'UPDATE kdag.job_steps SET status = $1, output_text = $2, duration_ms = $3, metadata = $4 WHERE job_run_id = $5 AND definition_step_index = $6 AND step_index = $7',
        ['completed', promptResult.text, stepDuration, batchMeta, runId, defStepIdx, i]
      );
    } catch (err: any) {
      const stepDuration = Date.now() - stepStart;
      const batchMeta = buildStepMeta(backend, model, batchTimeoutMs, { error: err.message });
      await query(
        'UPDATE kdag.job_steps SET status = $1, duration_ms = $2, output_text = $3, metadata = $4 WHERE job_run_id = $5 AND definition_step_index = $6 AND step_index = $7',
        ['failed', stepDuration, err.message, batchMeta, runId, defStepIdx, i]
      );
      throw new Error(`Batch step ${i} of '${defStep.key}' failed: ${err.message}`);
    }

    log.info({ runId, step: defStep.key, batch: i, total: batches.length, durationMs: Date.now() - stepStart }, 'Batch step completed');

    // Rate-limit delay between batches (skip after last batch)
    if (batchDelayMs > 0 && i < batches.length - 1) {
      log.info({ runId, step: defStep.key, delayMs: batchDelayMs }, 'Batch delay before next chunk');
      await new Promise(resolve => setTimeout(resolve, batchDelayMs));
    }
  }

  // Fan-in: collect batch outputs and merge
  const batchOutputs = await query<{ output_text: string }>(
    "SELECT output_text FROM kdag.job_steps WHERE job_run_id = $1 AND definition_step_index = $2 AND step_type = 'batch_summary' AND status = 'completed' ORDER BY step_index",
    [runId, defStepIdx]
  );

  const combinedSummaries = batchOutputs
    .map((r, i) => mergeTemplate.replace('{{index}}', String(i + 1)).replace('{{output}}', r.output_text))
    .join('\n\n---\n\n');

  const synthIndex = batches.length;
  const skipSynthesis = !!config.skip_synthesis;

  // Skip synthesis: concatenate batch outputs directly without an LLM call
  if (skipSynthesis) {
    await query(
      'UPDATE kdag.job_steps SET status = $1, input_chars = $2, input_text = $3, output_text = $4, duration_ms = 0, metadata = $5 WHERE job_run_id = $6 AND definition_step_index = $7 AND step_index = $8',
      ['completed', combinedSummaries.length, '(skip_synthesis: concatenated)', combinedSummaries, JSON.stringify({ skip_synthesis: true }), runId, defStepIdx, synthIndex]
    );

    log.info({ runId, step: defStep.key, mode: 'map_reduce_concat', batches: batches.length }, 'Map-reduce step completed (synthesis skipped)');
    return combinedSummaries;
  }

  // Synthesis step. If an update prompt is configured and existing_summary is
  // present, use the update prompt so synthesis continues from the previous
  // summary rather than producing a fresh standalone one.
  let synthPromptTemplate = synthesisPromptText;
  if (hasExistingSummary && updatePromptHandle) {
    const updatePromptRow = await querySingle<{ content: string }>(
      'SELECT content FROM prompts WHERE handle = $1',
      [updatePromptHandle]
    );
    if (updatePromptRow) {
      synthPromptTemplate = updatePromptRow.content;
    }
  }
  const synthPrompt = `${synthPromptTemplate}\n\n${generatedAtBlock}${previousSummaryBlock}Below are summaries of individual segments. Synthesize them into a single coherent output following the output format.\n\n---\n\n${combinedSummaries}`;

  await query(
    'UPDATE kdag.job_steps SET status = $1, input_chars = $2, input_text = $3 WHERE job_run_id = $4 AND definition_step_index = $5 AND step_index = $6',
    ['running', synthPrompt.length, synthPrompt, runId, defStepIdx, synthIndex]
  );

  const synthStart = Date.now();
  let finalOutput: string;
  let synthMetadata: Record<string, any> | undefined;
  try {
    const synthResult = await runPrompt({
      promptText: synthPrompt,
      backend,
      model: model || undefined,
      timeoutMs: synthTimeoutMs,
      useGoogleSearch,
      useUrlContext,
      useThinking,
      thinkingBudget,
      maxRetries,
      onChild,
    });
    finalOutput = synthResult.text;
    synthMetadata = synthResult.metadata;
  } catch (err: any) {
    const synthDuration = Date.now() - synthStart;
    const synthFailMeta = buildStepMeta(backend, model, synthTimeoutMs, { error: err.message });
    await query(
      'UPDATE kdag.job_steps SET status = $1, duration_ms = $2, output_text = $3, metadata = $4 WHERE job_run_id = $5 AND definition_step_index = $6 AND step_index = $7',
      ['failed', synthDuration, err.message, synthFailMeta, runId, defStepIdx, synthIndex]
    );
    throw new Error(`Synthesis step of '${defStep.key}' failed: ${err.message}`);
  }

  const synthDuration = Date.now() - synthStart;
  const synthMeta = buildStepMeta(backend, model, synthTimeoutMs, synthMetadata);
  await query(
    'UPDATE kdag.job_steps SET status = $1, output_text = $2, duration_ms = $3, metadata = $4 WHERE job_run_id = $5 AND definition_step_index = $6 AND step_index = $7',
    ['completed', finalOutput, synthDuration, synthMeta, runId, defStepIdx, synthIndex]
  );

  log.info({ runId, step: defStep.key, mode: 'map_reduce', batches: batches.length, synthDurationMs: synthDuration }, 'Map-reduce step completed');
  return finalOutput;
}

/**
 * Legacy retry path for jobs without a definition.
 * Resumes from completed map-reduce steps or re-runs a single call.
 */
async function executeLegacyRetry(
  runId: string,
  job: JobRow,
  inputs: JobInputRow[],
  opts?: { model?: string; stepTimeoutMs?: number },
  onChild?: (child: import('child_process').ChildProcess) => void
): Promise<string> {
  const promptInput = inputs.find(i => i.input_type_key === 'prompt');
  const chunkPromptInput = inputs.find(i => i.input_type_key === 'chunk_prompt');
  const transcriptInput = inputs.find(i => i.input_type_key === 'transcript');
  const existingSummaryInput = inputs.find(i => i.input_type_key === 'existing_summary');

  if (!promptInput?.content) {
    throw new Error(`Job ${job.id} has no prompt input`);
  }

  const inputContext = transcriptInput?.content || null;
  const inputLen = inputContext?.length ?? 0;
  const backend = resolveBackend(job.assistant_handle);

  if (inputLen > MAP_REDUCE_THRESHOLD) {
    if (!chunkPromptInput?.content) {
      throw new Error(`Job ${job.id} requires a chunk_prompt input for map-reduce`);
    }
    return executeMapReduce(runId, promptInput.content, chunkPromptInput.content, inputContext!, backend, opts?.model, true, opts?.stepTimeoutMs, undefined, onChild);
  }

  // Single-call re-run (delete old steps and re-execute)
  await query('DELETE FROM kdag.job_steps WHERE job_run_id = $1', [runId]);

  let promptWithContext = promptInput.content;
  if (existingSummaryInput?.content) {
    promptWithContext += `\n\n---\n\nExisting summary:\n\n${existingSummaryInput.content}`;
  }
  if (inputContext) {
    promptWithContext += `\n\n---\n\nSession transcript:\n\n${inputContext}`;
  }

  const result = await runPrompt({
    promptText: promptWithContext,
    backend,
    model: opts?.model || undefined,
    timeoutMs: opts?.stepTimeoutMs,
    onChild,
  });
  return result.text;
}

/**
 * Map-reduce execution for large sessions.
 * 1. Split input into batches
 * 2. Create step rows on the run
 * 3. Run each incomplete batch step
 * 4. Run synthesis step combining all batch outputs
 */
async function executeMapReduce(runId: string, promptText: string, chunkPromptText: string, inputContext: string, backend: 'claude' | 'codex' | 'gemini', model?: string, resuming?: boolean, timeoutMs?: number, _batchDelayMs?: number, onChild?: (child: import('child_process').ChildProcess) => void): Promise<string> {
  const batches = splitIntoBatches(inputContext);

  if (!resuming) {
    // Create step rows for a fresh run
    const client = await getClient();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < batches.length; i++) {
        const batchInput = `${chunkPromptText}\n\n---\n\n${batches[i]}`;
        await client.query(
          'INSERT INTO kdag.job_steps (job_run_id, step_index, step_type, input_chars, input_text) VALUES ($1, $2, $3, $4, $5)',
          [runId, i, 'batch_summary', batches[i].length, batchInput]
        );
      }
      await client.query(
        'INSERT INTO kdag.job_steps (job_run_id, step_index, step_type) VALUES ($1, $2, $3)',
        [runId, batches.length, 'synthesis']
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // Load existing step statuses (for resume: skip completed steps)
  const existingSteps = resuming
    ? await query<{ step_index: number; status: string }>(
        'SELECT step_index, status FROM kdag.job_steps WHERE job_run_id = $1 ORDER BY step_index',
        [runId]
      )
    : [];
  const completedSteps = new Set(
    existingSteps.filter(s => s.status === 'completed').map(s => s.step_index)
  );

  // Process batch steps
  for (let i = 0; i < batches.length; i++) {
    if (completedSteps.has(i)) {
      log.info({ runId, step: i, total: batches.length + 1 }, 'Skipping completed batch step');
      continue;
    }

    const stepStart = Date.now();
    const batchPrompt = `${chunkPromptText}\n\n---\n\n${batches[i]}`;

    await query(
      'UPDATE kdag.job_steps SET status = $1 WHERE job_run_id = $2 AND step_index = $3',
      ['running', runId, i]
    );

    try {
      const promptResult = await runPrompt({
        promptText: batchPrompt,
        backend,
        model: model || undefined,
        timeoutMs,
        onChild,
      });

      const stepDuration = Date.now() - stepStart;
      const legacyBatchMeta = buildStepMeta(backend, model, timeoutMs || STEP_TIMEOUT_MS);
      await query(
        'UPDATE kdag.job_steps SET status = $1, output_text = $2, duration_ms = $3, metadata = $4 WHERE job_run_id = $5 AND step_index = $6',
        ['completed', promptResult.text, stepDuration, legacyBatchMeta, runId, i]
      );
    } catch (err: any) {
      const stepDuration = Date.now() - stepStart;
      const legacyBatchMeta = buildStepMeta(backend, model, timeoutMs || STEP_TIMEOUT_MS, { error: err.message });
      await query(
        'UPDATE kdag.job_steps SET status = $1, duration_ms = $2, output_text = $3, metadata = $4 WHERE job_run_id = $5 AND step_index = $6',
        ['failed', stepDuration, err.message, legacyBatchMeta, runId, i]
      );
      throw new Error(`Batch step ${i} failed: ${err.message}`);
    }

    log.info({ runId, step: i, total: batches.length + 1, durationMs: Date.now() - stepStart }, 'Batch step completed');
  }

  // Synthesis step
  const synthIndex = batches.length;
  const batchOutputs = await query<{ output_text: string }>(
    "SELECT output_text FROM kdag.job_steps WHERE job_run_id = $1 AND step_type = 'batch_summary' AND status = 'completed' ORDER BY step_index",
    [runId]
  );

  const combinedSummaries = batchOutputs.map((r, i) => `## Segment ${i + 1}\n\n${r.output_text}`).join('\n\n---\n\n');
  const synthesisPrompt = `${promptText}\n\nBelow are summaries of individual segments of a session transcript. Synthesize them into a single coherent summary following the output format.\n\n---\n\n${combinedSummaries}`;

  await query(
    'UPDATE kdag.job_steps SET status = $1, input_chars = $2, input_text = $3 WHERE job_run_id = $4 AND step_index = $5',
    ['running', synthesisPrompt.length, synthesisPrompt, runId, synthIndex]
  );

  const synthStart = Date.now();
  let finalOutput: string;
  try {
    const synthResult = await runPrompt({
      promptText: synthesisPrompt,
      backend,
      model: model || undefined,
      timeoutMs,
      onChild,
    });
    finalOutput = synthResult.text;
  } catch (err: any) {
    const synthDuration = Date.now() - synthStart;
    const legacySynthMeta = buildStepMeta(backend, model, timeoutMs || STEP_TIMEOUT_MS, { error: err.message });
    await query(
      'UPDATE kdag.job_steps SET status = $1, duration_ms = $2, output_text = $3, metadata = $4 WHERE job_run_id = $5 AND step_index = $6',
      ['failed', synthDuration, err.message, legacySynthMeta, runId, synthIndex]
    );
    throw new Error(`Synthesis step failed: ${err.message}`);
  }

  const synthDuration = Date.now() - synthStart;
  const legacySynthMeta = buildStepMeta(backend, model, timeoutMs || STEP_TIMEOUT_MS);
  await query(
    'UPDATE kdag.job_steps SET status = $1, output_text = $2, duration_ms = $3, metadata = $4 WHERE job_run_id = $5 AND step_index = $6',
    ['completed', finalOutput, synthDuration, legacySynthMeta, runId, synthIndex]
  );

  return finalOutput;
}

/**
 * Retry a failed job run from where it left off.
 *
 * - Resets the failed run to 'running'
 * - Resets failed/canceled steps to 'pending'
 * - Re-executes, skipping already-completed steps
 */
export async function retryJobRun(jobId: string, runId: string, opts?: { model?: string; stepTimeoutMs?: number; batchDelayMs?: number }): Promise<string> {
  // Validate run exists and is failed
  const runRow = await querySingle<{ id: string; status: string }>(
    'SELECT id, status FROM kdag.job_runs WHERE id = $1 AND job_id = $2',
    [runId, jobId]
  );
  if (!runRow) {
    throw new Error(`Run ${runId} not found for job ${jobId}`);
  }
  if (runRow.status !== 'failed') {
    throw new Error(`Run ${runId} is ${runRow.status}, not failed`);
  }

  // Load job
  const job = await querySingle<JobRow>(
    `SELECT j.id, jt.key as job_type_key, j.assistant_id, a.handle as assistant_handle, j.project_id, j.definition_id, jd.key as definition_key
     FROM kdag.jobs j
     JOIN kdag.job_types jt ON jt.id = j.job_type_id
     JOIN assistants a ON a.id = j.assistant_id
     LEFT JOIN kdag.job_definitions jd ON jd.id = j.definition_id
     WHERE j.id = $1`,
    [jobId]
  );
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  // Load inputs
  const inputs = await query<JobInputRow>(
    `SELECT ji.id, it.key as input_type_key, ji.content, ji.ref_type, ji.ref_id
     FROM kdag.job_inputs ji
     JOIN kdag.input_types it ON it.id = ji.input_type_id
     WHERE ji.job_id = $1`,
    [jobId]
  );

  // Reset run and step statuses
  await query(
    "UPDATE kdag.job_runs SET status = 'running', error = NULL, exit_code = NULL, completed_at = NULL, started_at = NOW() WHERE id = $1",
    [runId]
  );
  await query(
    "UPDATE kdag.job_steps SET status = 'pending', output_text = NULL, duration_ms = NULL WHERE job_run_id = $1 AND status IN ('failed', 'canceled')",
    [runId]
  );

  // Register in worker pool
  activeJobs.set(jobId, { runId, child: null });
  const onChild = (child: import('child_process').ChildProcess) => {
    const entry = activeJobs.get(jobId);
    if (entry) entry.child = child;
  };
  const startTime = Date.now();

  try {
    let cwd: string | undefined;
    if (job.project_id) {
      const project = await querySingle<{ path: string | null }>(
        'SELECT path FROM projects WHERE id = $1',
        [job.project_id]
      );
      if (project?.path) {
        cwd = project.path;
      }
    }

    let finalOutput: string;

    if (job.definition_id) {
      // Definition-driven retry: keep completed steps, delete the rest, resume
      await query(
        "DELETE FROM kdag.job_steps WHERE job_run_id = $1 AND status != 'completed'",
        [runId]
      );
      finalOutput = await executeDefinitionJob(runId, job, inputs, cwd, opts, true, onChild);
    } else {
      // Legacy retry
      finalOutput = await executeLegacyRetry(runId, job, inputs, opts, onChild);
    }

    const durationMs = Date.now() - startTime;

    const textFormat = await querySingle<{ id: number }>(
      "SELECT id FROM kdag.output_formats WHERE key = 'text'",
      []
    );

    // Remove any old output from this run before inserting new one
    await query('DELETE FROM kdag.job_outputs WHERE job_run_id = $1', [runId]);

    await query(
      'INSERT INTO kdag.job_outputs (job_run_id, output_format_id, output_text) VALUES ($1, $2, $3)',
      [runId, textFormat!.id, finalOutput]
    );

    await query(
      'UPDATE kdag.job_runs SET status = $1, exit_code = 0, duration_ms = $2, completed_at = NOW() WHERE id = $3',
      ['completed', durationMs, runId]
    );

    const transcriptInput = inputs.find(i => i.input_type_key === 'transcript');
    if (job.job_type_key === 'session_summary' && transcriptInput?.ref_type === 'session' && transcriptInput.ref_id) {
      const newSnapshotId = await upsertSessionSummary(transcriptInput.ref_id, runId, finalOutput);
      if (job.definition_key === 'consolidate-session-summaries') {
        try {
          await trashOldSessionSnapshots(transcriptInput.ref_id, newSnapshotId);
        } catch (err: any) {
          log.error({ err: err.message, sessionId: transcriptInput.ref_id }, 'Failed to trash old snapshots after consolidation');
        }
      }
    }

    log.info({ jobId, runId, durationMs, outputLen: finalOutput.length, resumed: true }, 'Job run completed (retry)');
    return runId;
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    log.error({ jobId, runId, err: err.message, durationMs }, 'Job retry failed');

    await query(
      'UPDATE kdag.job_runs SET status = $1, error = $2, exit_code = $3, duration_ms = $4, completed_at = NOW() WHERE id = $5',
      ['failed', err.message, 1, durationMs, runId]
    );

    await query(
      "UPDATE kdag.job_steps SET status = 'canceled' WHERE job_run_id = $1 AND status = 'pending'",
      [runId]
    );

    await recordJobError(jobId, runId, job.definition_id, job.job_type_key, err.message, durationMs);

    throw err;
  } finally {
    activeJobs.delete(jobId);
    processQueue().catch(err => log.error({ err: err.message }, 'Error processing queue after retry'));
  }
}

/**
 * Rerun a completed job from a specific step (or batch within a map_reduce step).
 *
 * - Creates a new run
 * - Copies completed step outputs from the previous run for steps before fromStepKey
 * - If fromBatch is set, also copies completed batch steps before that index within the target map_reduce step
 * - Executes from fromStepKey onward using the resume path
 */
export async function rerunJobFromStep(
  jobId: string,
  fromStepKey: string,
  opts?: { model?: string; stepTimeoutMs?: number; batchDelayMs?: number; existingRunId?: string; fromBatch?: number }
): Promise<string> {
  // Load job
  const job = await querySingle<JobRow>(
    `SELECT j.id, jt.key as job_type_key, j.assistant_id, a.handle as assistant_handle, j.project_id, j.definition_id, jd.key as definition_key
     FROM kdag.jobs j
     JOIN kdag.job_types jt ON jt.id = j.job_type_id
     JOIN assistants a ON a.id = j.assistant_id
     LEFT JOIN kdag.job_definitions jd ON jd.id = j.definition_id
     WHERE j.id = $1`,
    [jobId]
  );
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }
  if (!job.definition_id) {
    throw new Error('Rerun from step is only supported for definition-driven jobs');
  }

  // Load definition steps to resolve fromStepKey
  const defSteps = await query<DefinitionStepRow>(
    `SELECT id, step_index, key, name, step_type, assistant_handle, model,
            prompt_handle, input_source, input_config, config, timeout_ms
     FROM kdag.job_definition_steps
     WHERE definition_id = $1
     ORDER BY step_index`,
    [job.definition_id]
  );
  const fromStep = defSteps.find(s => s.key === fromStepKey);
  if (!fromStep) {
    throw new Error(`Step '${fromStepKey}' not found in definition. Valid keys: ${defSteps.map(s => s.key).join(', ')}`);
  }

  // Find the latest completed run to copy steps from
  const completedRun = await querySingle<{ id: string }>(
    "SELECT id FROM kdag.job_runs WHERE job_id = $1 AND status = 'completed' ORDER BY created_at DESC LIMIT 1",
    [jobId]
  );
  if (!completedRun) {
    throw new Error('No completed run to rerun from');
  }

  // Load inputs
  const inputs = await query<JobInputRow>(
    `SELECT ji.id, it.key as input_type_key, ji.content, ji.ref_type, ji.ref_id
     FROM kdag.job_inputs ji
     JOIN kdag.input_types it ON it.id = ji.input_type_id
     WHERE ji.job_id = $1`,
    [jobId]
  );

  // Create a new run or reuse a queued one
  let runId: string;
  if (opts?.existingRunId) {
    await query(
      "UPDATE kdag.job_runs SET status = 'running', started_at = NOW(), model = COALESCE($2, model) WHERE id = $1",
      [opts.existingRunId, opts?.model || null]
    );
    runId = opts.existingRunId;
  } else {
    const run = await querySingle<{ id: string }>(
      `INSERT INTO kdag.job_runs (job_id, status, model, started_at)
       VALUES ($1, 'running', $2, NOW())
       RETURNING id`,
      [jobId, opts?.model || null]
    );
    runId = run!.id;
  }

  // Copy completed steps from the previous run for steps before fromStep
  if (fromStep.step_index > 0) {
    await query(
      `INSERT INTO kdag.job_steps (job_run_id, definition_step_index, step_index, step_type, status, input_chars, input_text, output_text, duration_ms, metadata)
       SELECT $1, definition_step_index, step_index, step_type, status, input_chars, input_text, output_text, duration_ms, metadata
       FROM kdag.job_steps
       WHERE job_run_id = $2 AND definition_step_index < $3 AND status = 'completed'`,
      [runId, completedRun.id, fromStep.step_index]
    );
  }

  // If from_batch is set, copy completed batch steps before that index within the target map_reduce step
  if (opts?.fromBatch != null && opts.fromBatch > 0) {
    await query(
      `INSERT INTO kdag.job_steps (job_run_id, definition_step_index, step_index, step_type, status, input_chars, input_text, output_text, duration_ms, metadata)
       SELECT $1, definition_step_index, step_index, step_type, status, input_chars, input_text, output_text, duration_ms, metadata
       FROM kdag.job_steps
       WHERE job_run_id = $2 AND definition_step_index = $3 AND step_index < $4 AND step_type = 'batch_summary' AND status = 'completed'`,
      [runId, completedRun.id, fromStep.step_index, opts.fromBatch]
    );
  }

  // Register in worker pool
  activeJobs.set(jobId, { runId, child: null });
  const onChild = (child: import('child_process').ChildProcess) => {
    const entry = activeJobs.get(jobId);
    if (entry) entry.child = child;
  };
  const startTime = Date.now();

  try {
    let cwd: string | undefined;
    if (job.project_id) {
      const project = await querySingle<{ path: string | null }>(
        'SELECT path FROM projects WHERE id = $1',
        [job.project_id]
      );
      if (project?.path) {
        cwd = project.path;
      }
    }

    const finalOutput = await executeDefinitionJob(runId, job, inputs, cwd, opts, true, onChild);

    const durationMs = Date.now() - startTime;

    const textFormat = await querySingle<{ id: number }>(
      "SELECT id FROM kdag.output_formats WHERE key = 'text'",
      []
    );

    await query(
      'INSERT INTO kdag.job_outputs (job_run_id, output_format_id, output_text) VALUES ($1, $2, $3)',
      [runId, textFormat!.id, finalOutput]
    );

    await query(
      'UPDATE kdag.job_runs SET status = $1, exit_code = 0, duration_ms = $2, completed_at = NOW() WHERE id = $3',
      ['completed', durationMs, runId]
    );

    const transcriptInput = inputs.find(i => i.input_type_key === 'transcript');
    if (job.job_type_key === 'session_summary' && transcriptInput?.ref_type === 'session' && transcriptInput.ref_id) {
      const newSnapshotId = await upsertSessionSummary(transcriptInput.ref_id, runId, finalOutput);
      if (job.definition_key === 'consolidate-session-summaries') {
        try {
          await trashOldSessionSnapshots(transcriptInput.ref_id, newSnapshotId);
        } catch (err: any) {
          log.error({ err: err.message, sessionId: transcriptInput.ref_id }, 'Failed to trash old snapshots after consolidation');
        }
      }
    }

    log.info({ jobId, runId, fromStep: fromStepKey, durationMs, outputLen: finalOutput.length }, 'Job rerun completed');
    return runId;
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    log.error({ jobId, runId, fromStep: fromStepKey, err: err.message, durationMs }, 'Job rerun failed');

    await query(
      'UPDATE kdag.job_runs SET status = $1, error = $2, exit_code = $3, duration_ms = $4, completed_at = NOW() WHERE id = $5',
      ['failed', err.message, 1, durationMs, runId]
    );

    await query(
      "UPDATE kdag.job_steps SET status = 'canceled' WHERE job_run_id = $1 AND status = 'pending'",
      [runId]
    );

    await recordJobError(jobId, runId, job.definition_id, job.job_type_key, err.message, durationMs);

    throw err;
  } finally {
    activeJobs.delete(jobId);
    processQueue().catch(err => log.error({ err: err.message }, 'Error processing queue after rerun'));
  }
}

/**
 * Upsert a session summary via the snapshot pattern.
 * Creates a snapshot, then points session_summaries.current_snapshot_id at it.
 * Returns the newly created snapshot id.
 */
async function upsertSessionSummary(sessionId: string, runId: string, content: string): Promise<string> {
  // Record current chunk count so incremental summaries know where to pick up
  const countRow = await querySingle<{ count: string }>(
    'SELECT COUNT(*)::integer as count FROM session_chunks WHERE session_id = $1',
    [sessionId]
  );
  const chunkCount = countRow ? parseInt(countRow.count, 10) : null;

  const snapshot = await querySingle<{ id: string }>(
    'INSERT INTO session_summary_snapshots (session_id, job_run_id, content, chunk_count) VALUES ($1, $2, $3, $4) RETURNING id',
    [sessionId, runId, content, chunkCount]
  );

  await query(
    `INSERT INTO session_summaries (session_id, current_snapshot_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (session_id) DO UPDATE SET
       current_snapshot_id = EXCLUDED.current_snapshot_id,
       updated_at = NOW()`,
    [sessionId, snapshot!.id]
  );

  return snapshot!.id;
}

/**
 * Trash all session summary snapshots except `keepSnapshotId`:
 * writes each to tmp/trash/session-summaries/<sessionId>/<snapshotId>.md
 * (with frontmatter), then deletes from the DB.
 */
async function trashOldSessionSnapshots(sessionId: string, keepSnapshotId: string): Promise<number> {
  const pathMod = require('path');
  const fs = require('fs');

  const oldSnapshots = await query<{ id: string; content: string; assistant_handle: string | null; created_at: string }>(
    `SELECT sss.id, sss.content, a.handle as assistant_handle, sss.created_at
     FROM session_summary_snapshots sss
     LEFT JOIN kdag.job_runs jr ON jr.id = sss.job_run_id
     LEFT JOIN kdag.jobs j ON j.id = jr.job_id
     LEFT JOIN assistants a ON a.id = j.assistant_id
     WHERE sss.session_id = $1 AND sss.id != $2
     ORDER BY sss.created_at ASC`,
    [sessionId, keepSnapshotId]
  );

  if (oldSnapshots.length === 0) return 0;

  const trashDir = pathMod.join('/tmp', 'khef-trash', 'session-summaries', sessionId);
  fs.mkdirSync(trashDir, { recursive: true });

  for (const snap of oldSnapshots) {
    const filePath = pathMod.join(trashDir, `${snap.id}.md`);
    const frontmatter = [
      '---',
      `snapshot_id: ${snap.id}`,
      `session_id: ${sessionId}`,
      `assistant_handle: ${snap.assistant_handle || 'unknown'}`,
      `created_at: ${new Date(snap.created_at).toISOString()}`,
      `trashed_at: ${new Date().toISOString()}`,
      `reason: consolidated`,
      '---',
      '',
      snap.content,
      '',
    ].join('\n');
    fs.writeFileSync(filePath, frontmatter, 'utf-8');
  }

  const ids = oldSnapshots.map(s => s.id);
  await query(
    `DELETE FROM session_summary_snapshots WHERE id = ANY($1::uuid[])`,
    [ids]
  );

  log.info({ sessionId, trashedCount: oldSnapshots.length, trashDir }, 'Trashed old session summary snapshots after consolidation');
  return oldSnapshots.length;
}

/** Check if any job is currently executing. */
export function isJobRunning(): boolean {
  return activeJobs.size > 0;
}

/** Check if the worker pool has capacity for another job. */
export function hasPoolCapacity(): boolean {
  return activeJobs.size < maxConcurrency;
}

/** Get all currently running job IDs. */
export function getRunningJobIds(): string[] {
  return [...activeJobs.keys()];
}

/** Kill a specific job's subprocess. The executor's catch block handles cleanup. */
export function cancelJobProcess(jobId: string): boolean {
  const entry = activeJobs.get(jobId);
  if (!entry?.child || entry.child.killed) return false;
  entry.child.kill('SIGTERM');
  const child = entry.child;
  setTimeout(() => {
    if (child && !child.killed) child.kill('SIGKILL');
  }, 5000);
  return true;
}

/** Kill all running subprocesses (for graceful shutdown). */
export function killAllProcesses(): void {
  for (const [, entry] of activeJobs) {
    if (entry.child && !entry.child.killed) {
      entry.child.kill('SIGTERM');
      const child = entry.child;
      setTimeout(() => {
        if (child && !child.killed) child.kill('SIGKILL');
      }, 5000);
    }
  }
}

// ============ Job Queue (DB-backed) ============

/** Get current queue state from the database. */
export async function getQueueState(): Promise<{
  running: string[];
  concurrency: { active: number; max: number };
  queue: Array<{ job_id: string; run_id: string; position: number }>;
}> {
  const rows = await query<{ job_id: string; run_id: string; position: string }>(
    `SELECT jq.job_id, jq.run_id,
            ROW_NUMBER() OVER (ORDER BY jq.created_at)::text AS position
     FROM kdag.job_queue jq
     JOIN kdag.job_runs jr ON jr.id = jq.run_id
     WHERE jr.status = 'queued'
     ORDER BY jq.created_at`,
    []
  );
  return {
    running: [...activeJobs.keys()],
    concurrency: { active: activeJobs.size, max: maxConcurrency },
    queue: rows.map(r => ({ job_id: r.job_id, run_id: r.run_id, position: parseInt(r.position, 10) })),
  };
}

/** Fill available pool slots from the queue (called from finally blocks and on concurrency change). */
async function processQueue(): Promise<void> {
  while (activeJobs.size < maxConcurrency) {
    const next = await querySingle<{
      id: string; job_id: string; run_id: string;
      step_timeout_ms: number | null; batch_delay_ms: number | null; is_retry: boolean;
      from_step: string | null; from_batch: number | null;
      model: string | null; cli_flags: Record<string, unknown> | null;
    }>(
      `SELECT jq.id, jq.job_id, jq.run_id, jq.step_timeout_ms, jq.batch_delay_ms, jq.is_retry, jq.from_step, jq.from_batch,
              jr.model, jr.cli_flags
       FROM kdag.job_queue jq
       JOIN kdag.job_runs jr ON jr.id = jq.run_id
       WHERE jr.status = 'queued'
       ORDER BY jq.created_at
       LIMIT 1`,
      []
    );
    if (!next) break;

    // Remove from queue
    await query('DELETE FROM kdag.job_queue WHERE id = $1', [next.id]);

    const opts = {
      model: next.model || undefined,
      cliFlags: next.cli_flags || undefined,
      stepTimeoutMs: next.step_timeout_ms || undefined,
      batchDelayMs: next.batch_delay_ms || undefined,
    };

    if (next.is_retry) {
      // Find the failed run to retry from
      const failedRun = await querySingle<{ id: string }>(
        "SELECT id FROM kdag.job_runs WHERE job_id = $1 AND status = 'failed' ORDER BY created_at DESC LIMIT 1",
        [next.job_id]
      );
      // Delete the queued placeholder run (retryJobRun resets the failed run directly)
      await query('DELETE FROM kdag.job_runs WHERE id = $1', [next.run_id]);
      if (!failedRun) {
        log.warn({ jobId: next.job_id }, 'Queued retry but no failed run found, skipping');
        continue;
      }
      log.info({ jobId: next.job_id, failedRunId: failedRun.id }, 'Processing queued retry');
      retryJobRun(next.job_id, failedRun.id, opts).catch(err => {
        log.error({ jobId: next.job_id, err: err.message }, 'Queued retry error');
      });
    } else if (next.from_step) {
      log.info({ jobId: next.job_id, runId: next.run_id, fromStep: next.from_step }, 'Processing queued rerun');
      rerunJobFromStep(next.job_id, next.from_step, { ...opts, existingRunId: next.run_id, fromBatch: next.from_batch ?? undefined }).catch(err => {
        log.error({ jobId: next.job_id, err: err.message }, 'Queued rerun error');
      });
    } else {
      log.info({ jobId: next.job_id, runId: next.run_id }, 'Processing queued job');
      executeJob(next.job_id, { ...opts, existingRunId: next.run_id }).catch(err => {
        log.error({ jobId: next.job_id, err: err.message }, 'Queued job execution error');
      });
    }
  }
}

/**
 * Initialize the job queue on server startup.
 * Recovers from crashes by marking orphaned running runs as failed
 * and processing any remaining queued jobs.
 */
export async function initJobQueue(): Promise<void> {
  // Load concurrency setting
  const concurrencyRow = await querySingle<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'kdag.maxConcurrency'"
  );
  maxConcurrency = Math.max(1, parseInt(concurrencyRow?.value ?? '3', 10));
  log.info({ maxConcurrency }, 'Job pool initialized');

  // Mark orphaned running runs as failed (server crashed mid-execution)
  const orphaned = await query(
    "UPDATE kdag.job_runs SET status = 'failed', error = 'Server restarted during execution', completed_at = NOW() WHERE status = 'running' RETURNING id",
    []
  );
  if (orphaned.length > 0) {
    log.info({ count: orphaned.length }, 'Marked orphaned running runs as failed');
  }

  // Clean up stale queue entries whose runs are no longer queued
  await query(
    "DELETE FROM kdag.job_queue jq USING kdag.job_runs jr WHERE jq.run_id = jr.id AND jr.status != 'queued'",
    []
  );

  // Process any remaining queued jobs (fills up to maxConcurrency slots)
  const queued = await querySingle<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM kdag.job_queue",
    []
  );
  if (queued && parseInt(queued.count, 10) > 0) {
    log.info({ count: queued.count }, 'Recovering queued jobs from previous session');
    processQueue().catch(err => {
      log.error({ err: err.message }, 'Error processing recovered queue');
    });
  }
}

/** Reload concurrency setting from the database. Call after updating the setting. */
export async function reloadConcurrency(): Promise<number> {
  const row = await querySingle<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'kdag.maxConcurrency'"
  );
  const prev = maxConcurrency;
  maxConcurrency = Math.max(1, parseInt(row?.value ?? '3', 10));
  log.info({ prev, maxConcurrency }, 'Concurrency reloaded');
  // If new limit is higher, try to fill new slots
  if (maxConcurrency > prev) {
    processQueue().catch(err => log.error({ err: err.message }, 'Error filling pool after concurrency change'));
  }
  return maxConcurrency;
}

// ============ Backend Availability ============

export interface KdagBackend {
  key: string;
  name: string;
  available: boolean;
  reason?: string;
  models: string[];
}

const CLAUDE_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'];
const CODEX_MODELS_FALLBACK = ['gpt-5.3-codex', 'o3', 'o4-mini'];
const GEMINI_MODELS_FALLBACK = ['gemini-2.0-flash-001', 'gemini-2.5-pro'];

/** Read configured Gemini models from settings, falling back to hardcoded defaults. */
async function getGeminiModels(): Promise<string[]> {
  try {
    const row = await querySingle<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'gemini.models'"
    );
    if (row?.value) {
      const parsed = JSON.parse(row.value) as Array<{ id: string; label?: string }>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map(m => m.id).filter(Boolean);
      }
    }
  } catch { /* ignore malformed setting */ }
  return GEMINI_MODELS_FALLBACK;
}

let backendsCache: { result: KdagBackend[]; expires: number } | null = null;

async function isCliAvailable(command: string): Promise<boolean> {
  try {
    await spawnAsync('which', [command]);
    return true;
  } catch {
    return false;
  }
}

/** Read the default model from ~/.codex/config.toml if present. */
async function getCodexDefaultModel(): Promise<string | null> {
  try {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    const content = fs.readFileSync(configPath, 'utf8') as string;
    const match = content.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Probe a single codex model to check account-level support.
 * Runs `codex exec --model <model> ""` — fails fast with "not supported"
 * on ChatGPT accounts for certain models.
 */
function probeCodexModel(model: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn('codex', ['exec', '-m', model, '-C', '/tmp', '--skip-git-repo-check', ''], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve(true); // Timeout — assume supported
    }, 15_000);

    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });

    child.on('close', () => {
      clearTimeout(timer);
      resolve(!output.includes('not supported'));
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Cached codex model probe results (account type doesn't change mid-session). */
let codexModelsCache: { models: string[]; expires: number } | null = null;

async function getCodexModels(): Promise<string[]> {
  if (codexModelsCache && Date.now() < codexModelsCache.expires) {
    return codexModelsCache.models;
  }

  // Build candidate list: config default model + fallback list, deduplicated
  const defaultModel = await getCodexDefaultModel();
  const candidates = [...new Set([
    ...(defaultModel ? [defaultModel] : []),
    ...CODEX_MODELS_FALLBACK,
  ])];

  // Probe all candidates in parallel
  const results = await Promise.all(
    candidates.map(async (m) => ({ model: m, ok: await probeCodexModel(m) }))
  );
  const models = results.filter(r => r.ok).map(r => r.model);

  codexModelsCache = { models, expires: Date.now() + 600_000 };
  return models;
}

/** Check which kdag backends are available. Cached for 60 seconds. */
export async function checkBackendAvailability(): Promise<KdagBackend[]> {
  if (backendsCache && Date.now() < backendsCache.expires) {
    return backendsCache.result;
  }

  const [claudeAvailable, codexAvailable, geminiStatus, geminiModels] = await Promise.all([
    isCliAvailable('claude'),
    isCliAvailable('codex'),
    checkGeminiStatus(),
    getGeminiModels(),
  ]);

  // Discover supported codex models (reads config + probes account)
  let codexModels: string[] = [];
  if (codexAvailable) {
    codexModels = await getCodexModels();
  }

  const backends: KdagBackend[] = [
    {
      key: 'claude-code',
      name: 'Claude Code',
      available: claudeAvailable,
      ...(!claudeAvailable && { reason: 'claude not found in PATH' }),
      models: CLAUDE_MODELS,
    },
    {
      key: 'codex-cli',
      name: 'Codex CLI',
      available: codexAvailable && codexModels.length > 0,
      ...(!codexAvailable && { reason: 'codex not found in PATH' }),
      ...(codexAvailable && codexModels.length === 0 && { reason: 'No supported models for this account' }),
      models: codexModels,
    },
    {
      key: 'gemini',
      name: 'Gemini',
      available: geminiStatus.available,
      ...(!geminiStatus.available && { reason: geminiStatus.reason }),
      models: geminiModels,
    },
  ];

  backendsCache = { result: backends, expires: Date.now() + 60_000 };
  return backends;
}
