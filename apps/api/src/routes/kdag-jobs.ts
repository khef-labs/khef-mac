/**
 * Job routes.
 * Prefix: /api/kdag
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as os from 'node:os';
import * as path from 'node:path';
import { query, querySingle } from '../db/client';
import { executeJob, retryJobRun, rerunJobFromStep, hasPoolCapacity, cancelJobProcess, checkBackendAvailability, getQueueState } from '../services/kdag-executor';
import { getJobErrors, clearJobErrors } from '../services/job-errors';
import { logger } from '../lib/logger';

const log = logger.child({ component: 'kdag-jobs' });

interface CreateJobBody {
  assistant_handle?: string;
  job_type?: string;
  definition_key?: string;
  session_id?: string;
  prompt_text?: string;
  system_prompt_text?: string;
  model?: string;
  cli_flags?: Record<string, unknown>;
  mode?: 'full' | 'incremental' | 'consolidate' | 'v2';
  project_id?: string;
  // Generic inputs for definition-driven jobs: { input_type_key: content_string }
  inputs?: Record<string, string>;
}

interface JobListQuery {
  status?: string;
  project?: string;
  job_type?: string;
  definition_key?: string;
  sort?: string;
  order?: string;
  limit?: string;
  offset?: string;
}

function isPathLikeInput(typeKey: string): boolean {
  return typeKey === 'path' || typeKey.endsWith('_path') || typeKey.endsWith('_dir');
}

function normalizeKdagInputContent(typeKey: string, content: string): string {
  if (!isPathLikeInput(typeKey)) return content;

  const trimmed = content.trim();
  if (!trimmed) return content;

  let normalized = trimmed;
  if (normalized === '~') {
    normalized = os.homedir();
  } else if (normalized.startsWith('~/')) {
    normalized = path.join(os.homedir(), normalized.slice(2));
  }

  return normalized;
}

export default async function promptJobRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/prompt/job - Create a new job with inputs
   */
  fastify.post('/job', async (
    request: FastifyRequest<{ Body: CreateJobBody }>,
    reply: FastifyReply
  ) => {
    const body = request.body;

    if (!body.job_type && !body.definition_key) {
      return reply.status(400).send({ error: 'job_type or definition_key is required' });
    }

    // Resolve definition — explicit definition_key takes priority, then auto-resolve from job_type/mode
    let definitionId: string | null = null;
    const sessionSummaryDefault =
      body.mode === 'consolidate' ? 'consolidate-session-summaries' :
      body.mode === 'v2' ? 'session-summary-v2' :
      'session-summary';
    const defKey = body.definition_key || (body.job_type === 'session_summary' ? sessionSummaryDefault : body.job_type);
    if (defKey) {
      const def = await querySingle<{ id: string }>(
        'SELECT id FROM kdag.job_definitions WHERE key = $1',
        [defKey]
      );
      if (body.definition_key && !def) {
        return reply.status(400).send({ error: `Unknown definition_key: ${body.definition_key}` });
      }
      if (def) {
        definitionId = def.id;
      }
    }

    // Resolve job type (for backward compat — still stored on jobs)
    const jobTypeKey = body.job_type || (body.definition_key === 'session-summary' ? 'session_summary' : 'custom');
    const jobType = await querySingle<{ id: number }>(
      'SELECT id FROM kdag.job_types WHERE key = $1',
      [jobTypeKey]
    );
    if (!jobType) {
      return reply.status(400).send({ error: `Unknown job_type: ${jobTypeKey}` });
    }

    // Resolve assistant
    const assistantHandle = body.assistant_handle || 'claude-code';
    const assistant = await querySingle<{ id: string }>(
      'SELECT id FROM assistants WHERE handle = $1',
      [assistantHandle]
    );
    if (!assistant) {
      return reply.status(400).send({ error: `Unknown assistant: ${assistantHandle}` });
    }

    let promptText = body.prompt_text || '';
    let projectId: string | null = null;

    // Resolve project from body if provided
    if (body.project_id) {
      const project = await querySingle<{ id: string }>(
        'SELECT id FROM projects WHERE id::text = $1 OR handle = $1 OR LOWER(name) = LOWER($1)',
        [body.project_id]
      );
      if (project) {
        projectId = project.id;
      }
    }

    // Collect inputs to insert after job creation
    const inputs: Array<{ typeKey: string; content: string | null; refType: string | null; refId: string | null }> = [];

    if (body.job_type === 'session_summary') {
      if (!body.session_id) {
        return reply.status(400).send({ error: 'session_id is required for session_summary jobs' });
      }

      // Load session
      let session = await querySingle<{ id: string; project_id: string | null; nickname: string | null; name: string | null; session_id: string }>(
        'SELECT id, project_id, nickname, name, session_id FROM sessions WHERE id = $1',
        [body.session_id]
      );
      if (!session) {
        session = await querySingle<{ id: string; project_id: string | null; nickname: string | null; name: string | null; session_id: string }>(
          'SELECT id, project_id, nickname, name, session_id FROM sessions WHERE session_id = $1',
          [body.session_id]
        );
      }
      if (!session) {
        return reply.status(404).send({ error: 'Session not found' });
      }

      // Check for existing pending/running run for this session
      const existingRun = await querySingle<{ id: string; status: string }>(
        `SELECT jr.id, jr.status FROM kdag.job_runs jr
         JOIN kdag.jobs j ON j.id = jr.job_id
         JOIN kdag.job_types jt ON jt.id = j.job_type_id
         JOIN kdag.job_inputs ji ON ji.job_id = j.id
         JOIN kdag.input_types it ON it.id = ji.input_type_id
         WHERE jt.key = 'session_summary'
           AND it.key = 'transcript'
           AND ji.ref_type = 'session'
           AND ji.ref_id = $1
           AND jr.status IN ('pending', 'running')
         LIMIT 1`,
        [session.id]
      );
      if (existingRun) {
        return reply.status(409).send({
          error: `A ${existingRun.status} summary run already exists for this session`,
          run_id: existingRun.id,
        });
      }

      projectId = session.project_id;

      const isConsolidate = body.mode === 'consolidate';
      const isIncremental = body.mode === 'incremental';
      const isV2 = body.mode === 'v2';

      if (isConsolidate) {
        const snapshots = await query<{ id: string; content: string; assistant_handle: string | null; created_at: string }>(
          `SELECT sss.id, sss.content, a.handle as assistant_handle, sss.created_at
           FROM session_summary_snapshots sss
           LEFT JOIN kdag.job_runs jr ON jr.id = sss.job_run_id
           LEFT JOIN kdag.jobs j ON j.id = jr.job_id
           LEFT JOIN assistants a ON a.id = j.assistant_id
           WHERE sss.session_id = $1
           ORDER BY sss.created_at ASC`,
          [session.id]
        );

        // Pull any Claude Code compaction chunks from this session's transcript —
        // they capture the pre-compaction narrative and should fold into the consolidated summary.
        const compactions = await query<{ chunk_index: number; content: string }>(
          `SELECT chunk_index, content
           FROM session_chunks
           WHERE session_id = $1
             AND content LIKE 'User: This session is being continued%'
           ORDER BY chunk_index ASC`,
          [session.id]
        );

        if (snapshots.length + compactions.length < 2) {
          return reply.status(400).send({ error: 'Consolidate requires at least 2 sources (summary snapshots + compactions combined)' });
        }

        const snapshotParts = snapshots.map((snap, i) => {
          const date = new Date(snap.created_at).toISOString();
          const who = snap.assistant_handle || 'unknown';
          return `## Summary Snapshot ${i + 1} (${who}, ${date})\n\n${snap.content}`;
        });

        const compactionParts = compactions.map((comp, i) => {
          return `## Compaction ${i + 1} (chunk ${comp.chunk_index})\n\n${comp.content}`;
        });

        const joined = [...compactionParts, ...snapshotParts].join('\n\n---\n\n');

        const sessionLabel = session.name || session.session_id;
        const metaLines: string[] = [];
        if (session.nickname) metaLines.push(`Session Nickname: ${session.nickname}`);
        metaLines.push(`Session: ${sessionLabel}`);
        metaLines.push(`Summary snapshot count: ${snapshots.length}`);
        metaLines.push(`Compaction count: ${compactions.length}`);
        const metaHeader = metaLines.join('\n') + '\n\n---\n\n';

        const consolidatedInput = metaHeader + joined;

        const promptRow = await querySingle<{ content: string }>(
          "SELECT content FROM prompts WHERE handle = 'consolidate-session-summaries'"
        );
        if (!promptRow) {
          return reply.status(500).send({ error: 'Prompt template consolidate-session-summaries not found. Run db:seed.' });
        }

        inputs.push({ typeKey: 'prompt', content: promptRow.content, refType: null, refId: null });
        inputs.push({ typeKey: 'transcript', content: consolidatedInput, refType: 'session', refId: session.id });
      } else {
        // Full / incremental / v2 modes — load session chunks as transcript input.
        // v2 mirrors full mode (whole-transcript fresh summarize) but also folds
        // in any existing summary at the consolidate step, then runs an editorial
        // prune. So it loads chunkOffset=0 like full, but also fetches existing
        // summary if present (without erroring on absence, unlike incremental).
        let existingSummary: string | null = null;
        let chunkOffset = 0;
        if (isIncremental) {
          const summaryRow = await querySingle<{ content: string; chunk_count: number | null }>(
            `SELECT sss.content, sss.chunk_count
             FROM session_summaries ss
             JOIN session_summary_snapshots sss ON sss.id = ss.current_snapshot_id
             WHERE ss.session_id = $1`,
            [session.id]
          );
          if (!summaryRow) {
            return reply.status(400).send({ error: 'No existing summary to update. Use full mode.' });
          }
          existingSummary = summaryRow.content;
          if (summaryRow.chunk_count !== null) {
            chunkOffset = summaryRow.chunk_count;
          }
        } else if (isV2) {
          const summaryRow = await querySingle<{ content: string }>(
            `SELECT sss.content
             FROM session_summaries ss
             JOIN session_summary_snapshots sss ON sss.id = ss.current_snapshot_id
             WHERE ss.session_id = $1`,
            [session.id]
          );
          if (summaryRow) {
            existingSummary = summaryRow.content;
          }
        }

        const chunks = await query<{ content: string }>(
          'SELECT content FROM session_chunks WHERE session_id = $1 AND chunk_index >= $2 ORDER BY chunk_index',
          [session.id, chunkOffset]
        );

        if (isIncremental && chunks.length === 0) {
          return reply.status(400).send({ error: 'No new session content since last summary. Nothing to update.' });
        }

        const metaLines: string[] = [];
        if (session.nickname) metaLines.push(`Session Nickname: ${session.nickname}`);
        if (session.name) metaLines.push(`Session Title: ${session.name}`);
        metaLines.push(`Session ID: ${session.session_id}`);
        const metaHeader = metaLines.length > 0 ? metaLines.join('\n') + '\n\n---\n\n' : '';
        const transcript = metaHeader + chunks.map(c => c.content).join('\n\n');

        if (!body.prompt_text) {
          // v2 always starts from a fresh summarize-session pass; the consolidate
          // step is where existing_summary gets folded in.
          const promptHandle = isIncremental ? 'update-session-summary' : 'summarize-session';
          const promptRow = await querySingle<{ content: string }>(
            'SELECT content FROM prompts WHERE handle = $1',
            [promptHandle]
          );
          if (!promptRow) {
            return reply.status(500).send({ error: `Prompt template ${promptHandle} not found. Run db:seed.` });
          }
          promptText = promptRow.content;
        }

        inputs.push({ typeKey: 'prompt', content: promptText, refType: null, refId: null });
        inputs.push({ typeKey: 'transcript', content: transcript, refType: 'session', refId: session.id });

        if (isIncremental && existingSummary) {
          inputs.push({ typeKey: 'existing_summary', content: existingSummary, refType: null, refId: null });
        }
        // v2 always inserts existing_summary (empty string when absent) so the
        // consolidate step's template renders cleanly with no missing-placeholder
        // surprises. When empty, the consolidate prompt sees a single substantive
        // snapshot and acts as light cleanup before the historian prune.
        if (isV2) {
          inputs.push({ typeKey: 'existing_summary', content: existingSummary || '', refType: null, refId: null });
        }

        const chunkPromptRow = await querySingle<{ content: string }>(
          "SELECT content FROM prompts WHERE handle = 'summarize-session-chunk'",
          []
        );
        if (!chunkPromptRow) {
          return reply.status(500).send({ error: 'Prompt template summarize-session-chunk not found. Run db:seed.' });
        }
        inputs.push({ typeKey: 'chunk_prompt', content: chunkPromptRow.content, refType: null, refId: null });
      }

    } else if (body.job_type === 'custom') {
      if (!body.prompt_text) {
        return reply.status(400).send({ error: 'prompt_text is required for custom jobs' });
      }
      inputs.push({ typeKey: 'prompt', content: promptText, refType: null, refId: null });
    } else if (body.definition_key && body.inputs) {
      // Generic definition-driven job creation with explicit inputs

      // For slack-channel-sync, honor the definition's promise of resolving
      // channel_id/workspace_id from the registered slack_channels row when only
      // channel_name is supplied. Also backfills workspace_name, export_path,
      // last_message_ts, and slack_channel_db_id so the export step sees the
      // same fields a hand-built call would have provided.
      //
      // When channel_name is shared across workspaces, any partial disambiguator
      // the caller already supplied (workspace_id, workspace_name, channel_id,
      // slack_channel_db_id) narrows the lookup before we declare ambiguity.
      if (defKey === 'slack-channel-sync' && body.inputs.channel_name) {
        const needsResolve = !body.inputs.channel_id || !body.inputs.workspace_id;
        if (needsResolve) {
          const filters: string[] = ['channel_name = $1'];
          const params: (string | undefined)[] = [String(body.inputs.channel_name)];
          const extraLabels: Array<{ field: string; value: string }> = [];
          const addFilter = (col: string, field: string, val: unknown) => {
            if (val) {
              params.push(String(val));
              filters.push(`${col} = $${params.length}`);
              extraLabels.push({ field, value: String(val) });
            }
          };
          addFilter('workspace_id', 'workspace_id', body.inputs.workspace_id);
          addFilter('workspace_name', 'workspace_name', body.inputs.workspace_name);
          addFilter('channel_id', 'channel_id', body.inputs.channel_id);
          addFilter('id', 'slack_channel_db_id', body.inputs.slack_channel_db_id);

          const candidates = await query<{
            id: string;
            channel_id: string;
            workspace_id: string;
            workspace_name: string | null;
            export_path: string | null;
            last_message_ts: string | null;
          }>(
            `SELECT id, channel_id, workspace_id, workspace_name, export_path, last_message_ts
             FROM slack_channels
             WHERE ${filters.join(' AND ')}`,
            params as string[]
          );
          if (candidates.length === 0) {
            const supplied = extraLabels.map(l => `${l.field}='${l.value}'`).join(', ');
            const suffix = supplied ? ` matching ${supplied}` : '';
            return reply.status(400).send({
              error: `No registered Slack channel with channel_name='${body.inputs.channel_name}'${suffix}. Register it first or pass channel_id and workspace_id explicitly.`,
            });
          }
          if (candidates.length > 1) {
            const workspaces = candidates.map(c => c.workspace_name ? `${c.workspace_name} (${c.workspace_id})` : c.workspace_id).join(', ');
            return reply.status(400).send({
              error: `${candidates.length} registered Slack channels share channel_name='${body.inputs.channel_name}' across workspaces: ${workspaces}. Pass workspace_id or workspace_name to disambiguate.`,
            });
          }
          const row = candidates[0];
          if (!body.inputs.channel_id) body.inputs.channel_id = row.channel_id;
          if (!body.inputs.workspace_id) body.inputs.workspace_id = row.workspace_id;
          if (!body.inputs.workspace_name && row.workspace_name) body.inputs.workspace_name = row.workspace_name;
          if (!body.inputs.slack_channel_db_id) body.inputs.slack_channel_db_id = row.id;
          if (!body.inputs.export_path && row.export_path) body.inputs.export_path = row.export_path;
          if (!body.inputs.last_message_ts && row.last_message_ts) body.inputs.last_message_ts = row.last_message_ts;
        }
      }

      // Validate required inputs against definition
      const defInputs = await query<{ input_type: string; required: boolean }>(
        `SELECT it.key as input_type, jdi.required
         FROM kdag.job_definition_inputs jdi
         JOIN kdag.input_types it ON it.id = jdi.input_type_id
         WHERE jdi.definition_id = $1`,
        [definitionId]
      );
      for (const di of defInputs) {
        if (di.required && !body.inputs[di.input_type]) {
          return reply.status(400).send({ error: `Missing required input: ${di.input_type}` });
        }
      }
      for (const [typeKey, content] of Object.entries(body.inputs)) {
        if (content) {
          inputs.push({
            typeKey,
            content: normalizeKdagInputContent(typeKey, String(content)),
            refType: null,
            refId: null,
          });
        }
      }
    } else if (body.definition_key) {
      // definition_key without inputs — only valid if definition has no required inputs
      const requiredInputs = await query<{ input_type: string }>(
        `SELECT it.key as input_type
         FROM kdag.job_definition_inputs jdi
         JOIN kdag.input_types it ON it.id = jdi.input_type_id
         WHERE jdi.definition_id = $1 AND jdi.required = true`,
        [definitionId]
      );
      if (requiredInputs.length > 0) {
        return reply.status(400).send({
          error: `Definition requires inputs: ${requiredInputs.map(i => i.input_type).join(', ')}`,
        });
      }
    } else {
      return reply.status(400).send({ error: `Unknown job_type: ${body.job_type}` });
    }

    // Add system prompt input if provided
    if (body.system_prompt_text) {
      inputs.push({ typeKey: 'system_prompt', content: body.system_prompt_text, refType: null, refId: null });
    }

    // Insert job
    const job = await querySingle<{ id: string; created_at: string }>(
      `INSERT INTO kdag.jobs (job_type_id, assistant_id, project_id, definition_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [jobType.id, assistant.id, projectId, definitionId]
    );

    // Insert inputs
    for (const input of inputs) {
      const inputType = await querySingle<{ id: number }>(
        'SELECT id FROM kdag.input_types WHERE key = $1',
        [input.typeKey]
      );
      await query(
        'INSERT INTO kdag.job_inputs (job_id, input_type_id, content, ref_type, ref_id) VALUES ($1, $2, $3, $4, $5)',
        [job!.id, inputType!.id, input.content, input.refType, input.refId]
      );
    }

    log.info({ jobId: job!.id, jobType: jobTypeKey, definitionKey: defKey }, 'Job created');

    return reply.status(201).send({ job: { id: job!.id, job_type: jobTypeKey, definition_key: defKey || null, created_at: job!.created_at } });
  });

  /**
   * POST /api/prompt/job/:id/run - Start or queue a job
   */
  fastify.post('/job/:id/run', async (
    request: FastifyRequest<{ Params: { id: string }; Body?: { model?: string; cli_flags?: Record<string, unknown>; step_timeout_ms?: number; batch_delay_ms?: number; assistant_handle?: string; queue?: boolean } }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;
    const body = request.body || {};
    const shouldQueue = body.queue !== false; // default true

    const job = await querySingle<{ id: string }>(
      'SELECT id FROM kdag.jobs WHERE id = $1',
      [id]
    );

    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }

    // Switch assistant if requested
    if (body.assistant_handle) {
      const assistant = await querySingle<{ id: string }>(
        'SELECT id FROM assistants WHERE handle = $1',
        [body.assistant_handle]
      );
      if (!assistant) {
        return reply.status(400).send({ error: `Unknown assistant: ${body.assistant_handle}` });
      }
      await query('UPDATE kdag.jobs SET assistant_id = $1 WHERE id = $2', [assistant.id, id]);
    }

    if (!hasPoolCapacity()) {
      if (!shouldQueue) {
        return reply.status(409).send({ error: 'Worker pool is full' });
      }
      // Check queue capacity
      const queueSize = await querySingle<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM kdag.job_queue",
        []
      );
      if (parseInt(queueSize!.count, 10) >= 20) {
        return reply.status(429).send({ error: 'Queue is full (max 20)' });
      }
      // Create a queued run record
      const run = await querySingle<{ id: string }>(
        `INSERT INTO kdag.job_runs (job_id, status, model, cli_flags)
         VALUES ($1, 'queued', $2, $3)
         RETURNING id`,
        [id, body.model || null, body.cli_flags ? JSON.stringify(body.cli_flags) : null]
      );
      // Insert into persistent queue
      await query(
        `INSERT INTO kdag.job_queue (job_id, run_id, step_timeout_ms, batch_delay_ms, is_retry)
         VALUES ($1, $2, $3, $4, false)`,
        [id, run!.id, body.step_timeout_ms || null, body.batch_delay_ms || null]
      );
      const posResult = await querySingle<{ position: string }>(
        "SELECT COUNT(*)::text AS position FROM kdag.job_queue WHERE created_at <= (SELECT created_at FROM kdag.job_queue WHERE run_id = $1)",
        [run!.id]
      );
      const position = parseInt(posResult!.position, 10);
      log.info({ jobId: id, runId: run!.id, position }, 'Job queued');
      return reply.status(202).send({ status: 'queued', job_id: id, run_id: run!.id, position });
    }

    // Start execution in the background — don't await
    executeJob(id, { model: body.model, cliFlags: body.cli_flags, stepTimeoutMs: body.step_timeout_ms, batchDelayMs: body.batch_delay_ms }).catch(err => {
      log.error({ jobId: id, err: err.message }, 'Unhandled job execution error');
    });

    return reply.status(202).send({ status: 'started', job_id: id });
  });

  /**
   * GET /api/prompt/jobs - List jobs with latest run status
   */
  fastify.get('/jobs', async (
    request: FastifyRequest<{ Querystring: JobListQuery }>,
    reply: FastifyReply
  ) => {
    const { status, project, job_type, definition_key, sort, order, limit = '20', offset = '0' } = request.query;
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const offsetNum = parseInt(offset, 10) || 0;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (status) {
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        const s = statuses[0];
        if (s === 'active') {
          conditions.push(`lr.status = 'running'`);
        } else if (s === 'pending') {
          conditions.push(`(lr.status = 'pending' OR lr.status IS NULL)`);
        } else {
          conditions.push(`lr.status = $${paramIndex++}`);
          params.push(s);
        }
      } else {
        // Multi-status: expand 'active' to 'running', 'pending' includes NULL
        const dbStatuses = statuses.map(s => s === 'active' ? 'running' : s);
        const hasPending = statuses.includes('pending');
        const nonPending = dbStatuses.filter(s => s !== 'pending');
        const parts: string[] = [];
        if (nonPending.length > 0) {
          parts.push(`lr.status = ANY($${paramIndex++})`);
          params.push(nonPending);
        }
        if (hasPending) {
          parts.push(`lr.status = 'pending'`);
          parts.push(`lr.status IS NULL`);
        }
        conditions.push(`(${parts.join(' OR ')})`);
      }
    }
    if (project) {
      conditions.push(`(p.handle = $${paramIndex} OR p.name = $${paramIndex})`);
      params.push(project);
      paramIndex++;
    }
    if (job_type) {
      conditions.push(`jt.key = $${paramIndex++}`);
      params.push(job_type);
    }
    if (definition_key) {
      const defKeys = definition_key.split(',').map(k => k.trim()).filter(Boolean);
      if (defKeys.length === 1) {
        conditions.push(`jd.key = $${paramIndex++}`);
        params.push(defKeys[0]);
      } else if (defKeys.length > 1) {
        conditions.push(`jd.key = ANY($${paramIndex++})`);
        params.push(defKeys);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT
        j.id, jt.key as job_type, j.requested_by, j.created_at,
        a.handle as assistant_handle,
        p.id::text as project_id,
        p.handle as project_handle,
        p.name as project_name,
        jd.key as definition_key,
        jd.name as definition_name,
        lr.id as run_id, lr.status as run_status, lr.model,
        lr.exit_code, lr.duration_ms, lr.error,
        lr.started_at as run_started_at, lr.completed_at as run_completed_at,
        (SELECT COUNT(*) FROM kdag.job_steps s WHERE s.job_run_id = lr.id) as step_count,
        (SELECT COUNT(*) FROM kdag.job_steps s WHERE s.job_run_id = lr.id AND s.status = 'completed') as steps_completed
      FROM kdag.jobs j
      JOIN kdag.job_types jt ON jt.id = j.job_type_id
      JOIN assistants a ON a.id = j.assistant_id
      LEFT JOIN projects p ON p.id = j.project_id
      LEFT JOIN kdag.job_definitions jd ON jd.id = j.definition_id
      LEFT JOIN LATERAL (
        SELECT * FROM kdag.job_runs WHERE job_id = j.id ORDER BY created_at DESC LIMIT 1
      ) lr ON true
      ${whereClause}
      ORDER BY ${(() => {
        const sortMap: Record<string, string> = {
          created_at: 'j.created_at',
          updated_at: 'COALESCE(lr.completed_at, lr.created_at, j.created_at)',
          last_run: 'COALESCE(lr.completed_at, lr.created_at, j.created_at)',
          type: 'COALESCE(jd.name, jt.key)',
          project: 'COALESCE(p.name, \'\')',
          status: 'COALESCE(lr.status, \'pending\')',
          duration: 'COALESCE(lr.duration_ms, 0)',
        };
        const col = sortMap[sort || ''] || 'COALESCE(lr.completed_at, lr.created_at, j.created_at)';
        const dir = order === 'asc' ? 'ASC' : 'DESC';
        return `${col} ${dir}`;
      })()}
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    params.push(limitNum, offsetNum);

    const jobs = await query(sql, params);

    const countParams = params.slice(0, -2);

    const countSql = `
      SELECT COUNT(*) as count
      FROM kdag.jobs j
      JOIN kdag.job_types jt ON jt.id = j.job_type_id
      JOIN assistants a ON a.id = j.assistant_id
      LEFT JOIN projects p ON p.id = j.project_id
      LEFT JOIN kdag.job_definitions jd ON jd.id = j.definition_id
      LEFT JOIN LATERAL (
        SELECT * FROM kdag.job_runs WHERE job_id = j.id ORDER BY created_at DESC LIMIT 1
      ) lr ON true
      ${whereClause}
    `;

    const statusCountsSql = `
      SELECT COALESCE(lr.status, 'pending') as status, COUNT(*)::int as count
      FROM kdag.jobs j
      LEFT JOIN LATERAL (
        SELECT status FROM kdag.job_runs WHERE job_id = j.id ORDER BY created_at DESC LIMIT 1
      ) lr ON true
      GROUP BY COALESCE(lr.status, 'pending')
    `;

    const [countResult, statusRows] = await Promise.all([
      querySingle<{ count: string }>(countSql, countParams),
      query<{ status: string; count: number }>(statusCountsSql),
    ]);
    const total = parseInt(countResult?.count ?? '0', 10);

    const status_counts: Record<string, number> = {};
    for (const row of statusRows) {
      status_counts[row.status] = row.count;
    }

    return {
      jobs: jobs.map(j => ({
        id: j.id,
        job_type: j.job_type,
        definition_key: j.definition_key || null,
        definition_name: j.definition_name || null,
        requested_by: j.requested_by,
        assistant_handle: j.assistant_handle,
        project_id: j.project_id || null,
        project_handle: j.project_handle,
        project_name: j.project_name,
        latest_run: j.run_id ? {
          id: j.run_id,
          status: j.run_status,
          model: j.model,
          exit_code: j.exit_code,
          duration_ms: j.duration_ms,
          error: j.error,
          step_count: parseInt(j.step_count, 10),
          steps_completed: parseInt(j.steps_completed, 10),
          started_at: j.run_started_at,
          completed_at: j.run_completed_at,
        } : null,
        created_at: j.created_at,
      })),
      pagination: {
        total_count: total,
        limit: limitNum,
        offset: offsetNum,
        has_more: offsetNum + limitNum < total,
      },
      status_counts,
    };
  });

  /**
   * GET /api/prompt/jobs/types - List valid job types
   */
  fastify.get('/jobs/types', async () => {
    const types = await query<{ key: string; description: string }>(
      'SELECT key, description FROM kdag.job_types ORDER BY id'
    );
    return { job_types: types };
  });

  /**
   * GET /api/prompt/job/:id - Get job details + inputs + latest run + output
   */
  fastify.get('/job/:id', async (
    request: FastifyRequest<{ Params: { id: string }; Querystring: { include_content?: string } }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;
    const includeContent = request.query.include_content === 'true';

    const job = await querySingle<any>(
      `SELECT j.id, j.definition_id, jt.key as job_type, j.requested_by, j.created_at,
              a.handle as assistant_handle,
              p.id::text as project_id, p.handle as project_handle, p.name as project_name,
              jd.key as definition_key, jd.name as definition_name
       FROM kdag.jobs j
       JOIN kdag.job_types jt ON jt.id = j.job_type_id
       JOIN assistants a ON a.id = j.assistant_id
       LEFT JOIN projects p ON p.id = j.project_id
       LEFT JOIN kdag.job_definitions jd ON jd.id = j.definition_id
       WHERE j.id = $1`,
      [id]
    );

    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }

    // Get inputs — optionally include content (but never for large transcripts)
    const inputSql = includeContent
      ? `SELECT ji.id, it.key as input_type, length(ji.content) as content_length,
                CASE WHEN it.key = 'transcript' THEN NULL ELSE ji.content END as content,
                ji.ref_type, ji.ref_id, ji.created_at
         FROM kdag.job_inputs ji
         JOIN kdag.input_types it ON it.id = ji.input_type_id
         WHERE ji.job_id = $1
         ORDER BY ji.created_at`
      : `SELECT ji.id, it.key as input_type, length(ji.content) as content_length, ji.ref_type, ji.ref_id, ji.created_at
         FROM kdag.job_inputs ji
         JOIN kdag.input_types it ON it.id = ji.input_type_id
         WHERE ji.job_id = $1
         ORDER BY ji.created_at`;

    const inputs = await query<any>(inputSql, [id]);

    // Get runs
    const runs = await query<any>(
      `SELECT jr.id, jr.status, jr.model, jr.exit_code, jr.error, jr.duration_ms,
              jr.started_at, jr.completed_at, jr.created_at,
              (SELECT COUNT(*) FROM kdag.job_steps s WHERE s.job_run_id = jr.id) as step_count,
              (SELECT COUNT(*) FROM kdag.job_steps s WHERE s.job_run_id = jr.id AND s.status = 'completed') as steps_completed
       FROM kdag.job_runs jr
       WHERE jr.job_id = $1
       ORDER BY jr.created_at DESC`,
      [id]
    );

    // Get steps for each run
    const runIds = runs.map((r: any) => r.id);
    let stepsByRun: Record<string, any[]> = {};
    if (runIds.length > 0) {
      const stepSql = includeContent
        ? `SELECT js.id, js.job_run_id, js.definition_step_index, js.step_index, js.step_type, js.status, js.input_chars, js.duration_ms,
                  js.input_text,
                  js.output_text,
                  js.metadata,
                  LENGTH(js.input_text) as input_length,
                  LENGTH(js.output_text) as output_length,
                  js.created_at,
                  ds.key as definition_step_key, ds.name as definition_step_name
           FROM kdag.job_steps js
           LEFT JOIN kdag.job_definition_steps ds ON ds.definition_id = $2 AND ds.step_index = js.definition_step_index
           WHERE js.job_run_id = ANY($1)
           ORDER BY js.definition_step_index, js.step_index`
        : `SELECT js.id, js.job_run_id, js.definition_step_index, js.step_index, js.step_type, js.status, js.input_chars, js.duration_ms,
                  LEFT(js.output_text || '', 500) as output_preview,
                  LENGTH(js.output_text) as output_length,
                  js.metadata,
                  js.created_at,
                  ds.key as definition_step_key, ds.name as definition_step_name
           FROM kdag.job_steps js
           LEFT JOIN kdag.job_definition_steps ds ON ds.definition_id = $2 AND ds.step_index = js.definition_step_index
           WHERE js.job_run_id = ANY($1)
           ORDER BY js.definition_step_index, js.step_index`;

      const steps = await query<any>(stepSql, [runIds, job.definition_id || null]);
      for (const step of steps) {
        if (!stepsByRun[step.job_run_id]) stepsByRun[step.job_run_id] = [];
        stepsByRun[step.job_run_id].push({
          id: step.id,
          definition_step_index: step.definition_step_index,
          definition_step_key: step.definition_step_key ?? null,
          definition_step_name: step.definition_step_name ?? null,
          step_index: step.step_index,
          step_type: step.step_type,
          status: step.status,
          input_chars: step.input_chars,
          input_text: step.input_text ?? undefined,
          duration_ms: step.duration_ms,
          output_preview: step.output_text ?? step.output_preview ?? null,
          output_length: step.output_length ? parseInt(step.output_length, 10) : null,
          metadata: step.metadata ?? null,
          created_at: step.created_at,
        });
      }
    }

    // Get outputs per run
    let outputsByRun: Record<string, string> = {};
    const completedRunIds = runs.filter((r: any) => r.status === 'completed').map((r: any) => r.id);
    if (completedRunIds.length > 0) {
      const outputs = await query<{ job_run_id: string; output_text: string }>(
        'SELECT job_run_id, output_text FROM kdag.job_outputs WHERE job_run_id = ANY($1)',
        [completedRunIds]
      );
      for (const o of outputs) {
        outputsByRun[o.job_run_id] = o.output_text;
      }
    }
    // Top-level output for backwards compat (latest completed run)
    const latestCompletedRun = runs.find((r: any) => r.status === 'completed');
    const output = latestCompletedRun ? (outputsByRun[latestCompletedRun.id] || null) : null;

    return {
      job: {
        id: job.id,
        job_type: job.job_type,
        definition_key: job.definition_key || null,
        definition_name: job.definition_name || null,
        requested_by: job.requested_by,
        assistant_handle: job.assistant_handle,
        project_id: job.project_id || null,
        project_handle: job.project_handle,
        project_name: job.project_name,
        created_at: job.created_at,
      },
      inputs: inputs.map((i: any) => ({
        id: i.id,
        input_type: i.input_type,
        content_length: parseInt(i.content_length, 10),
        content: i.content || undefined,
        ref_type: i.ref_type,
        ref_id: i.ref_id,
      })),
      runs: runs.map((r: any) => ({
        id: r.id,
        status: r.status,
        model: r.model,
        exit_code: r.exit_code,
        error: r.error,
        duration_ms: r.duration_ms,
        step_count: parseInt(r.step_count, 10),
        steps_completed: parseInt(r.steps_completed, 10),
        steps: stepsByRun[r.id] || [],
        output: outputsByRun[r.id] || null,
        started_at: r.started_at,
        completed_at: r.completed_at,
        created_at: r.created_at,
      })),
      output,
    };
  });

  /**
   * POST /api/prompt/job/:id/cancel - Cancel a running or queued job
   */
  fastify.post('/job/:id/cancel', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;

    // Check if queued first — remove from queue and mark run as failed
    const dequeued = await querySingle<{ run_id: string }>(
      "DELETE FROM kdag.job_queue WHERE job_id = $1 RETURNING run_id",
      [id]
    );
    if (dequeued) {
      await query(
        "UPDATE kdag.job_runs SET status = 'failed', error = 'Canceled by user (from queue)', completed_at = NOW() WHERE id = $1",
        [dequeued.run_id]
      );
      log.info({ jobId: id, runId: dequeued.run_id, wasQueued: true }, 'Queued job canceled by user');
      return { canceled: true, run_id: dequeued.run_id, was_queued: true };
    }

    // Find the running run for this job
    const runningRun = await querySingle<{ id: string }>(
      "SELECT id FROM kdag.job_runs WHERE job_id = $1 AND status = 'running' LIMIT 1",
      [id]
    );

    if (!runningRun) {
      // Handle orphaned pending runs (no queue entry, not running)
      const pendingRun = await querySingle<{ id: string }>(
        "SELECT id FROM kdag.job_runs WHERE job_id = $1 AND status = 'pending' LIMIT 1",
        [id]
      );
      if (pendingRun) {
        await query(
          "UPDATE kdag.job_runs SET status = 'failed', error = 'Canceled by user (orphaned pending)', completed_at = NOW() WHERE id = $1",
          [pendingRun.id]
        );
        log.info({ jobId: id, runId: pendingRun.id }, 'Orphaned pending job canceled by user');
        return { canceled: true, run_id: pendingRun.id, was_queued: false };
      }
      return reply.status(400).send({ error: 'No running, queued, or pending execution to cancel' });
    }

    // Kill the subprocess if this job is currently executing
    cancelJobProcess(id);

    // Mark run as failed
    await query(
      "UPDATE kdag.job_runs SET status = 'failed', error = 'Canceled by user', completed_at = NOW() WHERE id = $1",
      [runningRun.id]
    );

    // Cancel pending steps
    await query(
      "UPDATE kdag.job_steps SET status = 'canceled' WHERE job_run_id = $1 AND status IN ('pending', 'running')",
      [runningRun.id]
    );

    log.info({ jobId: id, runId: runningRun.id }, 'Job canceled by user');

    return { canceled: true, run_id: runningRun.id, was_queued: false };
  });

  /**
   * POST /api/prompt/job/:id/retry - Retry a failed run (queues if busy)
   */
  fastify.post('/job/:id/retry', async (
    request: FastifyRequest<{ Params: { id: string }; Body?: { model?: string; assistant_handle?: string; step_timeout_ms?: number; batch_delay_ms?: number; queue?: boolean } }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;
    const body = request.body || {};
    const shouldQueue = body.queue !== false;

    const job = await querySingle<{ id: string }>(
      'SELECT id FROM kdag.jobs WHERE id = $1',
      [id]
    );
    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }

    // Find the latest failed run
    const failedRun = await querySingle<{ id: string }>(
      "SELECT id FROM kdag.job_runs WHERE job_id = $1 AND status = 'failed' ORDER BY created_at DESC LIMIT 1",
      [id]
    );
    if (!failedRun) {
      return reply.status(400).send({ error: 'No failed run to retry' });
    }

    // Switch assistant if requested
    if (body.assistant_handle) {
      const assistant = await querySingle<{ id: string }>(
        'SELECT id FROM assistants WHERE handle = $1',
        [body.assistant_handle]
      );
      if (!assistant) {
        return reply.status(400).send({ error: `Unknown assistant: ${body.assistant_handle}` });
      }
      await query('UPDATE kdag.jobs SET assistant_id = $1 WHERE id = $2', [assistant.id, id]);
    }

    if (!hasPoolCapacity()) {
      if (!shouldQueue) {
        return reply.status(409).send({ error: 'Worker pool is full' });
      }
      // Check queue capacity
      const queueSize = await querySingle<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM kdag.job_queue",
        []
      );
      if (parseInt(queueSize!.count, 10) >= 20) {
        return reply.status(429).send({ error: 'Queue is full (max 20)' });
      }
      // Create a queued placeholder run for the retry
      const run = await querySingle<{ id: string }>(
        `INSERT INTO kdag.job_runs (job_id, status, model)
         VALUES ($1, 'queued', $2)
         RETURNING id`,
        [id, body.model || null]
      );
      // Insert into persistent queue
      await query(
        `INSERT INTO kdag.job_queue (job_id, run_id, step_timeout_ms, batch_delay_ms, is_retry)
         VALUES ($1, $2, $3, $4, true)`,
        [id, run!.id, body.step_timeout_ms || null, body.batch_delay_ms || null]
      );
      const posResult = await querySingle<{ position: string }>(
        "SELECT COUNT(*)::text AS position FROM kdag.job_queue WHERE created_at <= (SELECT created_at FROM kdag.job_queue WHERE run_id = $1)",
        [run!.id]
      );
      const position = parseInt(posResult!.position, 10);
      log.info({ jobId: id, runId: run!.id, position }, 'Retry queued');
      return reply.status(202).send({ status: 'queued', job_id: id, run_id: run!.id, position });
    }

    // Start retry in the background
    retryJobRun(id, failedRun.id, { model: body.model, stepTimeoutMs: body.step_timeout_ms, batchDelayMs: body.batch_delay_ms }).catch(err => {
      log.error({ jobId: id, runId: failedRun.id, err: err.message }, 'Unhandled job retry error');
    });

    return reply.status(202).send({ status: 'retrying', job_id: id, run_id: failedRun.id });
  });

  /**
   * POST /api/prompt/job/:id/rerun - Rerun a completed job from a specific step (queues if busy)
   */
  fastify.post('/job/:id/rerun', async (
    request: FastifyRequest<{ Params: { id: string }; Body?: { from_step?: string; from_batch?: number; model?: string; step_timeout_ms?: number; batch_delay_ms?: number; queue?: boolean } }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;
    const body = request.body || {};
    const shouldQueue = body.queue !== false;

    if (!body.from_step) {
      return reply.status(400).send({ error: 'from_step is required' });
    }

    const job = await querySingle<{ id: string; definition_id: string | null }>(
      'SELECT id, definition_id FROM kdag.jobs WHERE id = $1',
      [id]
    );
    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }
    if (!job.definition_id) {
      return reply.status(400).send({ error: 'Rerun from step is only supported for definition-driven jobs' });
    }

    // Validate from_step key exists in the definition
    const stepRow = await querySingle<{ key: string }>(
      'SELECT key FROM kdag.job_definition_steps WHERE definition_id = $1 AND key = $2',
      [job.definition_id, body.from_step]
    );
    if (!stepRow) {
      const validKeys = await query<{ key: string }>(
        'SELECT key FROM kdag.job_definition_steps WHERE definition_id = $1 ORDER BY step_index',
        [job.definition_id]
      );
      return reply.status(400).send({
        error: `Step '${body.from_step}' not found in definition. Valid keys: ${validKeys.map(s => s.key).join(', ')}`,
      });
    }

    // Verify there's a completed run to copy from
    const completedRun = await querySingle<{ id: string }>(
      "SELECT id FROM kdag.job_runs WHERE job_id = $1 AND status = 'completed' ORDER BY created_at DESC LIMIT 1",
      [id]
    );
    if (!completedRun) {
      return reply.status(400).send({ error: 'No completed run to rerun from' });
    }

    if (!hasPoolCapacity()) {
      if (!shouldQueue) {
        return reply.status(409).send({ error: 'Worker pool is full' });
      }
      const queueSize = await querySingle<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM kdag.job_queue",
        []
      );
      if (parseInt(queueSize!.count, 10) >= 20) {
        return reply.status(429).send({ error: 'Queue is full (max 20)' });
      }
      const run = await querySingle<{ id: string }>(
        `INSERT INTO kdag.job_runs (job_id, status, model)
         VALUES ($1, 'queued', $2)
         RETURNING id`,
        [id, body.model || null]
      );
      await query(
        `INSERT INTO kdag.job_queue (job_id, run_id, step_timeout_ms, batch_delay_ms, from_step, from_batch)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, run!.id, body.step_timeout_ms || null, body.batch_delay_ms || null, body.from_step, body.from_batch ?? null]
      );
      const posResult = await querySingle<{ position: string }>(
        "SELECT COUNT(*)::text AS position FROM kdag.job_queue WHERE created_at <= (SELECT created_at FROM kdag.job_queue WHERE run_id = $1)",
        [run!.id]
      );
      const position = parseInt(posResult!.position, 10);
      log.info({ jobId: id, runId: run!.id, fromStep: body.from_step, position }, 'Rerun queued');
      return reply.status(202).send({ status: 'queued', job_id: id, run_id: run!.id, from_step: body.from_step, position });
    }

    // Start rerun in the background
    rerunJobFromStep(id, body.from_step, { model: body.model, stepTimeoutMs: body.step_timeout_ms, batchDelayMs: body.batch_delay_ms, fromBatch: body.from_batch }).catch(err => {
      log.error({ jobId: id, fromStep: body.from_step, err: err.message }, 'Unhandled job rerun error');
    });

    return reply.status(202).send({ status: 'started', job_id: id, from_step: body.from_step });
  });

  /**
   * DELETE /api/prompt/jobs/:id - Delete a job (cascades to runs, inputs, outputs, steps)
   */
  fastify.delete('/jobs/:id', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;

    const job = await querySingle<{ id: string }>(
      'SELECT id FROM kdag.jobs WHERE id = $1',
      [id]
    );

    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }

    // Check no running or queued runs
    const activeRun = await querySingle<{ id: string; status: string }>(
      "SELECT id, status FROM kdag.job_runs WHERE job_id = $1 AND status IN ('running', 'queued') LIMIT 1",
      [id]
    );
    if (activeRun) {
      return reply.status(400).send({ error: `Cannot delete a job with a ${activeRun.status} execution` });
    }

    await query('DELETE FROM kdag.jobs WHERE id = $1', [id]);

    return reply.status(204).send();
  });

  /**
   * POST /api/kdag/jobs/bulk-delete - Delete multiple jobs (skips those with active runs)
   */
  fastify.post('/jobs/bulk-delete', async (
    request: FastifyRequest<{ Body: { job_ids: string[] } }>,
    reply: FastifyReply
  ) => {
    const { job_ids } = request.body || {};

    if (!Array.isArray(job_ids) || job_ids.length === 0) {
      return reply.status(400).send({ error: 'job_ids array is required' });
    }

    if (job_ids.length > 100) {
      return reply.status(400).send({ error: 'Cannot delete more than 100 jobs at once' });
    }

    // Find jobs with active runs to exclude
    const activeRows = await query<{ job_id: string }>(
      `SELECT DISTINCT job_id FROM kdag.job_runs
       WHERE job_id = ANY($1) AND status IN ('running', 'queued')`,
      [job_ids]
    );
    const activeJobIds = new Set(activeRows.map((r) => r.job_id));
    const deletableIds = job_ids.filter((id) => !activeJobIds.has(id));

    if (deletableIds.length === 0) {
      return reply.status(200).send({ deleted: 0, skipped: job_ids.length });
    }

    const deleted = await query<{ id: string }>(
      'DELETE FROM kdag.jobs WHERE id = ANY($1) RETURNING id',
      [deletableIds]
    );

    return reply.status(200).send({
      deleted: deleted.length,
      skipped: activeJobIds.size,
    });
  });

  /**
   * GET /api/kdag/job/:id/steps/:stepKey - Get step results by definition step key
   */
  fastify.get('/job/:id/steps/:stepKey', async (
    request: FastifyRequest<{ Params: { id: string; stepKey: string } }>,
    reply: FastifyReply
  ) => {
    const { id, stepKey } = request.params;

    // Verify job exists and get its definition
    const job = await querySingle<{ id: string; definition_id: string | null }>(
      'SELECT id, definition_id FROM kdag.jobs WHERE id = $1',
      [id]
    );
    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }
    if (!job.definition_id) {
      return reply.status(400).send({ error: 'Job has no definition' });
    }

    // Look up the definition step index by key
    const defStep = await querySingle<{ step_index: number; key: string; name: string; step_type: string }>(
      `SELECT step_index, key, name, step_type
       FROM kdag.job_definition_steps
       WHERE definition_id = $1 AND key = $2`,
      [job.definition_id, stepKey]
    );
    if (!defStep) {
      return reply.status(404).send({ error: `Step key '${stepKey}' not found in definition` });
    }

    // Get the latest run
    const latestRun = await querySingle<{ id: string; status: string }>(
      `SELECT id, status FROM kdag.job_runs
       WHERE job_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [id]
    );
    if (!latestRun) {
      return reply.status(404).send({ error: 'No runs found for this job' });
    }

    // Get all step records at this definition_step_index (handles map_reduce sub-steps)
    const steps = await query<any>(
      `SELECT id, definition_step_index, step_index, step_type, status,
              input_chars, input_text, output_text, duration_ms, metadata, created_at
       FROM kdag.job_steps
       WHERE job_run_id = $1 AND definition_step_index = $2
       ORDER BY step_index`,
      [latestRun.id, defStep.step_index]
    );

    return {
      step_key: defStep.key,
      step_name: defStep.name,
      step_type: defStep.step_type,
      run_id: latestRun.id,
      run_status: latestRun.status,
      records: steps.map((s: any) => ({
        id: s.id,
        step_index: s.step_index,
        step_type: s.step_type,
        status: s.status,
        input_chars: s.input_chars,
        input_text: s.input_text,
        output_text: s.output_text,
        duration_ms: s.duration_ms,
        metadata: s.metadata,
        created_at: s.created_at,
      })),
    };
  });

  /**
   * GET /api/kdag/queue - Get current queue state
   */
  fastify.get('/queue', async () => {
    return getQueueState();
  });

  /**
   * GET /api/kdag/backends - List available kdag backends with model suggestions
   */
  fastify.get('/backends', async (_request, reply) => {
    const backends = await checkBackendAvailability();
    return reply.send({ backends });
  });

  /**
   * GET /api/kdag/errors - List recent job errors from Redis cache
   */
  fastify.get('/errors', async (
    request: FastifyRequest<{ Querystring: { limit?: string; job_id?: string; definition_key?: string } }>,
    reply: FastifyReply
  ) => {
    const limit = Math.min(parseInt(request.query.limit || '20', 10) || 20, 100);
    const errors = await getJobErrors({
      limit,
      jobId: request.query.job_id,
      definitionKey: request.query.definition_key,
    });
    return reply.send({ errors, count: errors.length });
  });

  /**
   * DELETE /api/kdag/errors - Clear all cached job errors
   */
  fastify.delete('/errors', async (_request, reply) => {
    const cleared = await clearJobErrors();
    return reply.send({ cleared });
  });
}
