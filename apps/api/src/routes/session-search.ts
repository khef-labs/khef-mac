/**
 * Session search routes.
 * Full-text search across session transcripts.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as fs from 'fs';
import { query, querySingle, getClient } from '../db/client';
import { triggerSessionSync, getSessionSyncStatus } from '../services/session-worker';
import { markdownToSlack } from '../services/markdown-to-slack';
import { SESSION_PATHS } from '../services/session-sync';
import { grepSessions, type GrepOptions } from '../services/session-grep';
import { getHiddenProjectHandles } from '../utils/hidden-projects';
import { getPhysFootprint } from './stats';

function formatMemoryBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${parseFloat(value.toFixed(1))} ${units[i]}`;
}

interface SessionListQuery {
  assistant?: string;
  project?: string;
  q?: string;
  session_id?: string;
  limit?: string;
  offset?: string;
  sort?: 'started_at' | 'ended_at' | 'updated_at' | 'file_size';
  order?: 'asc' | 'desc';
  includeHidden?: string;
}

const ALLOWED_SORT_FIELDS = new Set(['started_at', 'ended_at', 'updated_at', 'file_size']);

interface SessionRow {
  id: string;
  session_id: string;
  assistant_handle: string;
  assistant_name: string;
  project_id: string | null;
  project_handle: string | null;
  project_display_name: string | null;
  project_name: string | null;
  name: string | null;
  summary: string | null;
  message_count: number | null;
  file_size: string;
  file_path: string;
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
  updated_at: Date;
  nickname: string | null;
  model: string | null;
  total_input_tokens: string | null;
  total_output_tokens: string | null;
  context_window_tokens: string | null;
  chunk_count: string;
  search_excerpt?: string | null;
  pid: number | null;
  status: string | null;
}

interface SessionSearchResult {
  id: string;
  session_id: string;
  nickname: string | null;
  assistant_handle: string;
  project_id: string | null;
  project_handle: string | null;
  name: string | null;
  summary: string | null;
  excerpt: string;
  chunk_index: number;
  rank: number;
}

function formatSession(r: SessionRow, checkResumable = false) {
  return {
    id: r.id,
    session_id: r.session_id,
    assistant: {
      handle: r.assistant_handle,
      name: r.assistant_name,
    },
    project: r.project_id ? {
      id: r.project_id,
      handle: r.project_handle,
      display_name: r.project_display_name,
      name: r.project_name,
    } : null,
    name: r.name,
    nickname: r.nickname,
    summary: r.summary,
    message_count: r.message_count,
    file_size: parseInt(r.file_size, 10),
    file_path: r.file_path,
    chunk_count: parseInt(r.chunk_count, 10),
    started_at: r.started_at?.toISOString() ?? null,
    ended_at: r.ended_at?.toISOString() ?? null,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    model: r.model ?? null,
    total_input_tokens: r.total_input_tokens ? parseInt(r.total_input_tokens, 10) : null,
    total_output_tokens: r.total_output_tokens ? parseInt(r.total_output_tokens, 10) : null,
    context_window_tokens: r.context_window_tokens ? parseInt(r.context_window_tokens, 10) : null,
    pid: r.pid ?? null,
    status: r.status ?? null,
    ...(r.search_excerpt ? { search_excerpt: r.search_excerpt } : {}),
    ...(checkResumable ? { resumable: r.file_path ? fs.existsSync(r.file_path) : false } : {}),
  };
}

export default async function sessionSearchRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/sessions/counts - Per-assistant session totals
   * Returns an array of { assistant_handle, assistant_name, total, active } for all assistants with sessions.
   */
  fastify.get('/counts', async (_request: FastifyRequest, _reply: FastifyReply) => {
    const sessionHandles = Object.keys(SESSION_PATHS);
    const rows = await query<{
      assistant_handle: string;
      assistant_name: string;
      total: string;
      active: string;
    }>(`
      SELECT
        a.handle as assistant_handle,
        a.name as assistant_name,
        COUNT(s.id) as total,
        COUNT(s.id) FILTER (WHERE s.status = 'active') as active
      FROM assistants a
      LEFT JOIN sessions s ON s.assistant_id = a.id
      WHERE a.handle = ANY($1)
      GROUP BY a.id, a.handle, a.name
      ORDER BY a.name
    `, [sessionHandles]);

    return {
      counts: rows.map(r => ({
        assistant_handle: r.assistant_handle,
        assistant_name: r.assistant_name,
        total: parseInt(r.total, 10),
        active: parseInt(r.active, 10),
      })),
    };
  });

  /**
   * GET /api/sessions - List sessions
   */
  fastify.get('/', async (
    request: FastifyRequest<{ Querystring: SessionListQuery }>,
    reply: FastifyReply
  ) => {
    const { assistant, project, q, session_id, limit = '50', offset = '0', sort: rawSort = 'started_at', order = 'desc', includeHidden } = request.query;
    const sort = ALLOWED_SORT_FIELDS.has(rawSort) ? rawSort : 'started_at';
    const limitNum = Math.min(parseInt(limit, 10) || 50, 100);
    const offsetNum = parseInt(offset, 10) || 0;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;
    let qParamIndex: number | null = null;

    if (assistant) {
      conditions.push(`a.handle = $${paramIndex++}`);
      params.push(assistant);
    }

    if (project) {
      conditions.push(`(p.handle = $${paramIndex} OR p.name = $${paramIndex} OR p.id::text = $${paramIndex})`);
      params.push(project);
      paramIndex++;
    }

    if (includeHidden !== 'true') {
      const hiddenHandles = await getHiddenProjectHandles();
      if (hiddenHandles.length > 0) {
        conditions.push(`(p.handle IS NULL OR p.handle <> ALL($${paramIndex}))`);
        params.push(hiddenHandles);
        paramIndex++;
      }
    }

    if (session_id) {
      // Partial match: prefix OR suffix on the file-based session_id
      const sid = session_id.toLowerCase();
      conditions.push(`(s.session_id::text ILIKE $${paramIndex} || '%' OR s.session_id::text ILIKE '%' || $${paramIndex})`);
      params.push(sid);
      paramIndex++;
    }

    if (q) {
      qParamIndex = paramIndex;
      // Substring search across session chunk content (messages, tool calls)
      conditions.push(`EXISTS (
        SELECT 1 FROM session_chunks sc
        WHERE sc.session_id = s.id
        AND sc.content ILIKE '%' || $${paramIndex++} || '%'
      )`);
      params.push(q);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderClause = `ORDER BY s.${sort} ${order.toUpperCase()} NULLS LAST`;

    // When searching, extract a ~200 char excerpt around the first match
    const excerptColumn = qParamIndex !== null
      ? `, (SELECT substring(sc.content FROM greatest(1, position(lower($${qParamIndex}) in lower(sc.content)) - 80) FOR 200)
           FROM session_chunks sc
           WHERE sc.session_id = s.id AND sc.content ILIKE '%' || $${qParamIndex} || '%'
           LIMIT 1) as search_excerpt`
      : '';

    const sql = `
      SELECT
        s.id,
        s.session_id,
        a.handle as assistant_handle,
        a.name as assistant_name,
        s.project_id,
        p.handle as project_handle,
        p.display_name as project_display_name, p.name as project_name,
        s.name,
        s.nickname,
        s.summary,
        s.message_count,
        s.file_size,
        s.file_path,
        s.started_at,
        s.ended_at,
        s.created_at,
        s.updated_at,
        s.model,
        s.total_input_tokens,
        s.total_output_tokens,
        s.context_window_tokens,
        s.pid,
        s.status,
        (SELECT COUNT(*) FROM session_chunks sc WHERE sc.session_id = s.id) as chunk_count
        ${excerptColumn}
      FROM sessions s
      JOIN assistants a ON a.id = s.assistant_id
      LEFT JOIN projects p ON p.id = s.project_id
      ${whereClause}
      ${orderClause}
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    params.push(limitNum, offsetNum);

    const rows = await query<SessionRow>(sql, params);

    // Get total count
    const countSql = `
      SELECT COUNT(*) as count
      FROM sessions s
      JOIN assistants a ON a.id = s.assistant_id
      LEFT JOIN projects p ON p.id = s.project_id
      ${whereClause}
    `;
    const countResult = await querySingle<{ count: string }>(countSql, params.slice(0, -2));
    const total = parseInt(countResult?.count ?? '0', 10);

    const sessions = rows.map(r => formatSession(r));

    return {
      sessions,
      pagination: {
        total,
        limit: limitNum,
        offset: offsetNum,
      },
    };
  });

  /**
   * GET /api/sessions/search - Full-text search in session content
   */
  fastify.get('/search', async (
    request: FastifyRequest<{ Querystring: { q: string; assistant?: string; project?: string; session_id?: string; exclude_session_id?: string; limit?: string; includeHidden?: string } }>,
    reply: FastifyReply
  ) => {
    const { q, assistant, project, session_id, exclude_session_id, limit = '20', includeHidden } = request.query;

    if (!q || q.trim().length < 2) {
      return reply.status(400).send({ error: 'Query must be at least 2 characters' });
    }

    const limitNum = Math.min(parseInt(limit, 10) || 20, 50);

    const conditions: string[] = [];
    const params: any[] = [q];
    let paramIndex = 2;

    if (assistant) {
      conditions.push(`a.handle = $${paramIndex++}`);
      params.push(assistant);
    }

    if (project) {
      conditions.push(`(p.handle = $${paramIndex} OR p.name = $${paramIndex} OR p.id::text = $${paramIndex})`);
      params.push(project);
      paramIndex++;
    }

    if (session_id) {
      conditions.push(`s.session_id = $${paramIndex++}`);
      params.push(session_id);
    }

    if (exclude_session_id) {
      conditions.push(`s.session_id != $${paramIndex++}`);
      params.push(exclude_session_id);
    }

    if (includeHidden !== 'true') {
      const hiddenHandles = await getHiddenProjectHandles();
      if (hiddenHandles.length > 0) {
        conditions.push(`(p.handle IS NULL OR p.handle <> ALL($${paramIndex++}))`);
        params.push(hiddenHandles);
      }
    }

    const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

    // Build a word-level regex from the query so a partial summary match (e.g.
    // summary mentions "voice" but not "khef" or "update") still triggers the
    // boost. plainto_tsquery uses AND semantics and would otherwise require every
    // stem to be present in the summary.
    const queryTokens = Array.from(new Set(
      q.toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(t => t.length >= 3 && !['the','and','for','with','this','that','from','was','were','are','you','your','have','has','not','but','any','all','what','how','why','when','who','can','get','set','use','using','into'].includes(t))
        .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    ));
    const summaryPattern = queryTokens.length > 0
      ? `\\y(${queryTokens.join('|')})\\y`
      : null;

    const summaryPatternParamIndex = summaryPattern ? paramIndex++ : null;
    if (summaryPattern) params.push(summaryPattern);

    const summaryBoostExpr = summaryPatternParamIndex
      ? `CASE
            WHEN s.summary IS NOT NULL AND s.summary ~* $${summaryPatternParamIndex} THEN 2.0
            WHEN s.name IS NOT NULL AND s.name ~* $${summaryPatternParamIndex} THEN 1.5
            ELSE 1.0
          END`
      : '1.0';

    // Blend text relevance with recency decay (30-day e-folding) and boost
    // results whose summary or name contains any query term — a concentrated
    // mention in the curated summary is a much stronger signal than scattered
    // chunk matches on broad terms.
    const sql = `
      SELECT
        s.id,
        s.session_id,
        s.nickname,
        a.handle as assistant_handle,
        p.id::text as project_id,
        p.handle as project_handle,
        s.name,
        s.summary,
        sc.chunk_index,
        ts_headline('english', sc.content, plainto_tsquery('english', $1),
          'MaxWords=50, MinWords=20, StartSel=<<, StopSel=>>') as excerpt,
        (
          ts_rank(to_tsvector('english', sc.content), plainto_tsquery('english', $1))
          * EXP(
              -GREATEST(
                0,
                EXTRACT(EPOCH FROM (NOW() - COALESCE(s.started_at, s.ended_at, s.updated_at, s.created_at)))
                  / 86400.0
              ) / 30.0
            )
          * ${summaryBoostExpr}
        ) as rank
      FROM session_chunks sc
      JOIN sessions s ON s.id = sc.session_id
      JOIN assistants a ON a.id = s.assistant_id
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE to_tsvector('english', sc.content) @@ plainto_tsquery('english', $1)
      ${whereClause}
      ORDER BY rank DESC
      LIMIT $${paramIndex++}
    `;

    params.push(limitNum);

    const rows = await query<SessionSearchResult>(sql, params);

    const results = rows.map(r => ({
      id: r.id,
      session_id: r.session_id,
      nickname: r.nickname || null,
      assistant_handle: r.assistant_handle,
      project_id: r.project_id || null,
      project_handle: r.project_handle,
      name: r.name,
      summary: r.summary,
      chunk_index: r.chunk_index,
      excerpt: r.excerpt,
      rank: r.rank,
    }));

    return { results, query: q };
  });

  /**
   * GET /api/sessions/:id - Get a single session with chunks
   */
  fastify.get('/:id', async (
    request: FastifyRequest<{ Params: { id: string }; Querystring: { include_chunks?: string } }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;
    const includeChunks = request.query.include_chunks === 'true';

    // Try to find by database ID first, then by file-based session_id
    let session = await querySingle<SessionRow>(`
      SELECT
        s.id,
        s.session_id,
        a.handle as assistant_handle,
        a.name as assistant_name,
        s.project_id,
        p.handle as project_handle,
        p.display_name as project_display_name, p.name as project_name,
        s.name,
        s.nickname,
        s.summary,
        s.message_count,
        s.file_size,
        s.file_path,
        s.started_at,
        s.ended_at,
        s.created_at,
        s.updated_at,
        s.model,
        s.total_input_tokens,
        s.total_output_tokens,
        s.context_window_tokens,
        s.pid,
        s.status,
        (SELECT COUNT(*) FROM session_chunks sc WHERE sc.session_id = s.id) as chunk_count
      FROM sessions s
      JOIN assistants a ON a.id = s.assistant_id
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.id = $1
    `, [id]);

    // If not found by database ID, try by file-based session_id
    if (!session) {
      session = await querySingle<SessionRow>(`
        SELECT
          s.id,
          s.session_id,
          a.handle as assistant_handle,
          a.name as assistant_name,
          s.project_id,
          p.handle as project_handle,
          p.display_name as project_display_name, p.name as project_name,
          s.name,
          s.nickname,
          s.summary,
          s.message_count,
          s.file_size,
          s.file_path,
          s.started_at,
          s.ended_at,
          s.created_at,
          s.updated_at,
          s.model,
          s.total_input_tokens,
          s.total_output_tokens,
          s.context_window_tokens,
          s.pid,
          s.status,
          (SELECT COUNT(*) FROM session_chunks sc WHERE sc.session_id = s.id) as chunk_count
        FROM sessions s
        JOIN assistants a ON a.id = s.assistant_id
        LEFT JOIN projects p ON p.id = s.project_id
        WHERE s.session_id = $1
      `, [id]);
    }

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    let chunks: Array<{ id: string; chunk_index: number; content: string; message_count: number | null }> | undefined;

    if (includeChunks) {
      const chunkRows = await query<{ id: string; chunk_index: number; content: string; message_count: number | null }>(
        'SELECT id, chunk_index, content, message_count FROM session_chunks WHERE session_id = $1 ORDER BY chunk_index',
        [session.id]
      );
      chunks = chunkRows;
    }

    return {
      session: formatSession(session, true),
      chunks,
    };
  });

  /**
   * PATCH /api/sessions/:id - Update session metadata (summary, name)
   */
  fastify.patch('/:id', async (
    request: FastifyRequest<{ Params: { id: string }; Body: { summary?: string; name?: string } }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;
    const { summary, name } = request.body || {};

    if (summary === undefined && name === undefined) {
      return reply.status(400).send({ error: 'At least one field (summary, name) is required' });
    }

    // Find session by DB ID or file UUID
    let session = await querySingle<{ id: string }>('SELECT id FROM sessions WHERE id = $1', [id]);
    if (!session) {
      session = await querySingle<{ id: string }>('SELECT id FROM sessions WHERE session_id = $1', [id]);
    }
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const sets: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (summary !== undefined) {
      sets.push(`summary = $${paramIndex++}`);
      params.push(summary);
    }
    if (name !== undefined) {
      sets.push(`name = $${paramIndex++}`);
      params.push(name);
    }

    params.push(session.id);
    const result = await querySingle<{ id: string; summary: string | null; name: string | null; updated_at: string }>(
      `UPDATE sessions SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${paramIndex} RETURNING id, summary, name, updated_at`,
      params
    );

    return { session: result };
  });

  /**
   * GET /api/sessions/by-session-id/:sessionId - Lookup by original file UUID
   */
  fastify.get('/by-session-id/:sessionId', async (
    request: FastifyRequest<{ Params: { sessionId: string }; Querystring: { include_chunks?: string } }>,
    reply: FastifyReply
  ) => {
    const { sessionId } = request.params;
    const includeChunks = request.query.include_chunks === 'true';

    const session = await querySingle<SessionRow>(`
      SELECT
        s.id,
        s.session_id,
        a.handle as assistant_handle,
        a.name as assistant_name,
        s.project_id,
        p.handle as project_handle,
        p.display_name as project_display_name, p.name as project_name,
        s.name,
        s.nickname,
        s.summary,
        s.message_count,
        s.file_size,
        s.file_path,
        s.started_at,
        s.ended_at,
        s.created_at,
        s.updated_at,
        s.model,
        s.total_input_tokens,
        s.total_output_tokens,
        s.context_window_tokens,
        s.pid,
        s.status,
        (SELECT COUNT(*) FROM session_chunks sc WHERE sc.session_id = s.id) as chunk_count
      FROM sessions s
      JOIN assistants a ON a.id = s.assistant_id
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.session_id = $1
    `, [sessionId]);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    let chunks: Array<{ id: string; chunk_index: number; content: string; message_count: number | null }> | undefined;

    if (includeChunks) {
      const chunkRows = await query<{ id: string; chunk_index: number; content: string; message_count: number | null }>(
        'SELECT id, chunk_index, content, message_count FROM session_chunks WHERE session_id = $1 ORDER BY chunk_index',
        [session.id]
      );
      chunks = chunkRows;
    }

    return {
      session: formatSession(session, true),
      chunks,
    };
  });

  /**
   * GET /api/sessions/:id/live-memory - Current phys_footprint for the session's PID.
   * Returns 404 if session not found. Returns { pid: null } if the session has no PID.
   * Returns { pid, memory_bytes: null } if vmmap fails (process exited, no permission).
   */
  fastify.get('/:id/live-memory', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;

    let session = await querySingle<{ pid: number | null; status: string | null }>(
      'SELECT pid, status FROM sessions WHERE id = $1',
      [id]
    );
    if (!session) {
      session = await querySingle<{ pid: number | null; status: string | null }>(
        'SELECT pid, status FROM sessions WHERE session_id = $1',
        [id]
      );
    }
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    if (session.pid == null) {
      return { pid: null, memory_bytes: null, memory_human: null };
    }

    const bytes = await getPhysFootprint(session.pid);
    return {
      pid: session.pid,
      memory_bytes: bytes,
      memory_human: bytes != null ? formatMemoryBytes(bytes) : null,
    };
  });

  /**
   * GET /api/sessions/:id/summary - Get session summary + job status
   */
  fastify.get('/:id/summary', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;

    // Find session by DB id, file-based session_id, or snapshot UUID
    let session = await querySingle<{ id: string }>(
      'SELECT id FROM sessions WHERE id = $1',
      [id]
    );
    if (!session) {
      session = await querySingle<{ id: string }>(
        'SELECT id FROM sessions WHERE session_id = $1',
        [id]
      );
    }
    if (!session) {
      // Try resolving via snapshot UUID
      session = await querySingle<{ id: string }>(
        'SELECT session_id as id FROM session_summary_snapshots WHERE id = $1',
        [id]
      );
    }
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    // Check for existing summary (snapshot pattern) — include assistant_handle
    const summary = await querySingle<{
      snapshot_id: string;
      content: string;
      assistant_handle: string;
      snapshot_created_at: string;
      updated_at: string;
    }>(
      `SELECT ss.current_snapshot_id as snapshot_id, sss.content,
              a.handle as assistant_handle,
              sss.created_at as snapshot_created_at, ss.updated_at
       FROM session_summaries ss
       JOIN session_summary_snapshots sss ON sss.id = ss.current_snapshot_id
       JOIN kdag.job_runs jr ON jr.id = sss.job_run_id
       JOIN kdag.jobs j ON j.id = jr.job_id
       JOIN assistants a ON a.id = j.assistant_id
       WHERE ss.session_id = $1`,
      [session.id]
    );

    // Fetch all snapshots (lightweight — no content)
    const snapshots = await query<{
      id: string;
      assistant_handle: string;
      created_at: string;
    }>(
      `SELECT sss.id, a.handle as assistant_handle, sss.created_at
       FROM session_summary_snapshots sss
       JOIN kdag.job_runs jr ON jr.id = sss.job_run_id
       JOIN kdag.jobs j ON j.id = jr.job_id
       JOIN assistants a ON a.id = j.assistant_id
       WHERE sss.session_id = $1
       ORDER BY sss.created_at DESC`,
      [session.id]
    );

    // Get the latest JOB targeting this session, then its latest run (if any).
    // Anchoring on the job (not the run) avoids a race where runKdagJob returns
    // 202 before executeJob has inserted the new run — if we sorted runs directly,
    // we'd surface the previous job's stale run + step_progress.
    const latestRun = await querySingle<{
      run_id: string | null;
      job_id: string;
      status: string;
      error: string | null;
      created_at: string;
      duration_ms: number | null;
    }>(
      `SELECT jr.id as run_id,
              j.id as job_id,
              COALESCE(jr.status, 'pending') as status,
              jr.error,
              COALESCE(jr.created_at, j.created_at) as created_at,
              jr.duration_ms
       FROM kdag.jobs j
       JOIN kdag.job_types jt ON jt.id = j.job_type_id
       JOIN kdag.job_inputs ji ON ji.job_id = j.id
       JOIN kdag.input_types it ON it.id = ji.input_type_id
       LEFT JOIN LATERAL (
         SELECT id, status, error, created_at, duration_ms
         FROM kdag.job_runs
         WHERE job_id = j.id
         ORDER BY created_at DESC
         LIMIT 1
       ) jr ON true
       WHERE jt.key = 'session_summary'
         AND it.key = 'transcript'
         AND ji.ref_type = 'session'
         AND ji.ref_id = $1
       ORDER BY j.created_at DESC
       LIMIT 1`,
      [session.id]
    );

    // Get step progress if run has steps
    let stepProgress: { total: number; completed: number } | null = null;
    if (latestRun?.run_id) {
      const progress = await querySingle<{ total: string; completed: string }>(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE status = 'completed') as completed
         FROM kdag.job_steps WHERE job_run_id = $1`,
        [latestRun.run_id]
      );
      const total = parseInt(progress?.total ?? '0', 10);
      if (total > 0) {
        stepProgress = {
          total,
          completed: parseInt(progress?.completed ?? '0', 10),
        };
      }
    }

    if (!summary && !latestRun) {
      return reply.status(404).send({ error: 'No summary found for this session' });
    }

    // Only surface job info when it's actionable:
    // - pending/running: UI needs to poll for progress
    // - any status when a summary exists: shows which job produced it
    // Stale failed/completed runs with no summary are not useful to the frontend.
    const isJobActive = latestRun && (latestRun.status === 'pending' || latestRun.status === 'running');
    const showJob = latestRun && (isJobActive || summary);

    return {
      summary: summary ? {
        id: summary.snapshot_id,
        content: summary.content,
        assistant_handle: summary.assistant_handle,
        created_at: summary.snapshot_created_at,
        updated_at: summary.updated_at,
      } : null,
      snapshots: snapshots.map(s => ({
        id: s.id,
        assistant_handle: s.assistant_handle,
        created_at: s.created_at,
      })),
      job: showJob ? {
        id: latestRun.job_id,
        run_id: latestRun.run_id,
        status: latestRun.status,
        error: latestRun.error,
        duration_ms: latestRun.duration_ms,
        created_at: latestRun.created_at,
        step_progress: stepProgress,
      } : null,
    };
  });

  /**
   * PATCH /api/sessions/:id/summary - Update summary content
   */
  fastify.patch('/:id/summary', async (
    request: FastifyRequest<{ Params: { id: string }; Body: { content: string } }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;
    const { content } = request.body || {};

    if (!content || typeof content !== 'string') {
      return reply.status(400).send({ error: 'content is required' });
    }

    // Find session
    let session = await querySingle<{ id: string }>(
      'SELECT id FROM sessions WHERE id = $1',
      [id]
    );
    if (!session) {
      session = await querySingle<{ id: string }>(
        'SELECT id FROM sessions WHERE session_id = $1',
        [id]
      );
    }
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    // Get current summary pointer
    const summaryRow = await querySingle<{ current_snapshot_id: string }>(
      'SELECT current_snapshot_id FROM session_summaries WHERE session_id = $1',
      [session.id]
    );

    if (!summaryRow) {
      return reply.status(404).send({ error: 'No summary exists for this session' });
    }

    // Update the snapshot content and the summary timestamp
    await query(
      'UPDATE session_summary_snapshots SET content = $1 WHERE id = $2',
      [content, summaryRow.current_snapshot_id]
    );
    const updated = await querySingle<{ updated_at: string }>(
      'UPDATE session_summaries SET updated_at = NOW() WHERE session_id = $1 RETURNING updated_at',
      [session.id]
    );

    return {
      summary: {
        id: summaryRow.current_snapshot_id,
        content,
        updated_at: updated!.updated_at,
      },
    };
  });

  /**
   * GET /api/sessions/:id/summary/export - Export summary as markdown or slack mrkdwn
   */
  fastify.get('/:id/summary/export', async (
    request: FastifyRequest<{ Params: { id: string }; Querystring: { format?: string; scope?: string } }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;
    const format = request.query.format || 'markdown';
    const scope = request.query.scope || 'current';

    if (!['markdown', 'slack'].includes(format)) {
      return reply.status(400).send({ error: 'format must be markdown or slack' });
    }
    if (!['current', 'all'].includes(scope)) {
      return reply.status(400).send({ error: 'scope must be current or all' });
    }

    // Resolve session (DB id or session_uuid)
    let session = await querySingle<{ id: string; name: string | null; session_id: string }>(
      'SELECT id, name, session_id FROM sessions WHERE id::text = $1',
      [id]
    );
    if (!session) {
      session = await querySingle<{ id: string; name: string | null; session_id: string }>(
        'SELECT id, name, session_id FROM sessions WHERE session_id = $1',
        [id]
      );
    }
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    if (scope === 'all') {
      // Export all snapshots in chronological order (join to get assistant handle)
      const snapshots = await query<{ content: string; assistant_handle: string; created_at: string }>(
        `SELECT sss.content, COALESCE(a.handle, 'unknown') as assistant_handle, sss.created_at
         FROM session_summary_snapshots sss
         LEFT JOIN kdag.job_runs jr ON jr.id = sss.job_run_id
         LEFT JOIN kdag.jobs j ON j.id = jr.job_id
         LEFT JOIN assistants a ON a.id = j.assistant_id
         WHERE sss.session_id = $1
         ORDER BY sss.created_at ASC`,
        [session.id]
      );

      if (snapshots.length === 0) {
        return reply.status(404).send({ error: 'No summaries found for this session' });
      }

      const sessionLabel = session.name || session.session_id;
      const parts = snapshots.map((snap, i) => {
        const num = i + 1;
        const date = new Date(snap.created_at).toLocaleString();
        const header = `## Summary #${num} (${snap.assistant_handle}, ${date})`;
        return `${header}\n\n${snap.content}`;
      });

      const combined = `# Session Summaries: ${sessionLabel}\n\n${parts.join('\n\n---\n\n')}`;

      if (format === 'slack') {
        return { text: markdownToSlack(combined) };
      }
      return { text: combined };
    }

    // scope === 'current'
    const snapshot = await querySingle<{ content: string }>(
      `SELECT sss.content
       FROM session_summaries ss
       JOIN session_summary_snapshots sss ON sss.id = ss.current_snapshot_id
       WHERE ss.session_id = $1`,
      [session.id]
    );

    if (!snapshot) {
      return reply.status(404).send({ error: 'No summary found for this session' });
    }

    if (format === 'slack') {
      return { text: markdownToSlack(snapshot.content) };
    }
    return { text: snapshot.content };
  });

  /**
   * GET /api/sessions/:id/summary/snapshots/:snapshotId - Get a single snapshot's content
   */
  fastify.get('/:id/summary/snapshots/:snapshotId', async (
    request: FastifyRequest<{ Params: { id: string; snapshotId: string } }>,
    reply: FastifyReply
  ) => {
    const { id, snapshotId } = request.params;

    // Resolve session
    let session = await querySingle<{ id: string }>(
      'SELECT id FROM sessions WHERE id = $1',
      [id]
    );
    if (!session) {
      session = await querySingle<{ id: string }>(
        'SELECT id FROM sessions WHERE session_id = $1',
        [id]
      );
    }
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const snapshot = await querySingle<{
      id: string;
      content: string;
      assistant_handle: string;
      created_at: string;
    }>(
      `SELECT sss.id, sss.content, a.handle as assistant_handle, sss.created_at
       FROM session_summary_snapshots sss
       JOIN kdag.job_runs jr ON jr.id = sss.job_run_id
       JOIN kdag.jobs j ON j.id = jr.job_id
       JOIN assistants a ON a.id = j.assistant_id
       WHERE sss.id = $1 AND sss.session_id = $2`,
      [snapshotId, session.id]
    );

    if (!snapshot) {
      return reply.status(404).send({ error: 'Snapshot not found' });
    }

    return {
      snapshot: {
        id: snapshot.id,
        content: snapshot.content,
        assistant_handle: snapshot.assistant_handle,
        created_at: snapshot.created_at,
      },
    };
  });

  /**
   * DELETE /api/sessions/:id/summary/snapshots/:snapshotId - Delete a single snapshot.
   * If it's the current snapshot, repoint to the next most recent.
   * If it's the last snapshot, cascades through session_summaries.
   */
  fastify.delete('/:id/summary/snapshots/:snapshotId', async (
    request: FastifyRequest<{ Params: { id: string; snapshotId: string } }>,
    reply: FastifyReply
  ) => {
    const { id, snapshotId } = request.params;

    let session = await querySingle<{ id: string }>(
      'SELECT id FROM sessions WHERE id = $1',
      [id]
    );
    if (!session) {
      session = await querySingle<{ id: string }>(
        'SELECT id FROM sessions WHERE session_id = $1',
        [id]
      );
    }
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const snapshot = await querySingle<{ id: string }>(
      'SELECT id FROM session_summary_snapshots WHERE id = $1 AND session_id = $2',
      [snapshotId, session.id]
    );
    if (!snapshot) {
      return reply.status(404).send({ error: 'Snapshot not found' });
    }

    const summaryPtr = await querySingle<{ current_snapshot_id: string }>(
      'SELECT current_snapshot_id FROM session_summaries WHERE session_id = $1',
      [session.id]
    );
    const isCurrent = summaryPtr?.current_snapshot_id === snapshotId;

    const client = await getClient();
    try {
      await client.query('BEGIN');

      if (isCurrent) {
        const next = await client.query<{ id: string }>(
          `SELECT id FROM session_summary_snapshots
           WHERE session_id = $1 AND id != $2
           ORDER BY created_at DESC
           LIMIT 1`,
          [session.id, snapshotId]
        );

        if (next.rows.length > 0) {
          // Repoint current to next, then delete old (avoids cascade on summaries row).
          await client.query(
            'UPDATE session_summaries SET current_snapshot_id = $1, updated_at = NOW() WHERE session_id = $2',
            [next.rows[0].id, session.id]
          );
          await client.query(
            'DELETE FROM session_summary_snapshots WHERE id = $1',
            [snapshotId]
          );
        } else {
          // Last snapshot — cascade from session_summaries deletion handles the row.
          await client.query(
            'DELETE FROM session_summary_snapshots WHERE id = $1',
            [snapshotId]
          );
        }
      } else {
        await client.query(
          'DELETE FROM session_summary_snapshots WHERE id = $1',
          [snapshotId]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return reply.status(204).send();
  });

  /**
   * DELETE /api/sessions/:id/summary - Delete all summaries for a session.
   */
  fastify.delete('/:id/summary', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;

    let session = await querySingle<{ id: string }>(
      'SELECT id FROM sessions WHERE id = $1',
      [id]
    );
    if (!session) {
      session = await querySingle<{ id: string }>(
        'SELECT id FROM sessions WHERE session_id = $1',
        [id]
      );
    }
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    // Deleting all snapshots cascades through session_summaries.current_snapshot_id.
    await query(
      'DELETE FROM session_summary_snapshots WHERE session_id = $1',
      [session.id]
    );

    return reply.status(204).send();
  });

  /**
   * POST /api/sessions/sync - Trigger manual sync
   */
  fastify.post('/sync', async (
    request: FastifyRequest<{ Querystring: { force?: string } }>,
    reply: FastifyReply
  ) => {
    const force = request.query.force === 'true';
    const result = await triggerSessionSync({ force });
    return result;
  });

  /**
   * GET /api/sessions/sync/status - Get sync status
   */
  fastify.get('/sync/status', async () => {
    return getSessionSyncStatus();
  });

  /**
   * GET /api/sessions/by-nickname/:nickname - Get session lineage by nickname
   * Returns all sessions sharing a nickname with summary snapshot IDs and compaction summary chunk IDs.
   */
  fastify.get('/by-nickname/:nickname', async (
    request: FastifyRequest<{ Params: { nickname: string } }>,
    reply: FastifyReply
  ) => {
    const { nickname } = request.params;
    const normalizedNickname = nickname.toLowerCase().trim();

    // Find all sessions with this nickname, chronologically
    const sessions = await query<{
      id: string;
      session_id: string;
      project_id: string | null;
      project_handle: string | null;
      project_name: string | null;
      assistant_handle: string;
      message_count: number | null;
      started_at: string | null;
      ended_at: string | null;
      nickname: string | null;
    }>(
      `SELECT s.id, s.session_id, s.project_id,
              p.handle as project_handle, p.display_name as project_display_name, p.name as project_name,
              a.handle as assistant_handle,
              s.message_count, s.started_at, s.ended_at, s.nickname
       FROM sessions s
       JOIN assistants a ON a.id = s.assistant_id
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE s.nickname = $1
       ORDER BY s.started_at ASC NULLS LAST`,
      [normalizedNickname]
    );

    if (sessions.length === 0) {
      return reply.status(404).send({ error: 'No sessions found with this nickname' });
    }

    const sessionDbIds = sessions.map(s => s.id);

    // Fetch all summary snapshots for these sessions
    const snapshots = await query<{
      session_id: string;
      snapshot_id: string;
      created_at: string;
      chunk_count: number | null;
    }>(
      `SELECT sss.session_id::text, sss.id as snapshot_id, sss.created_at, sss.chunk_count
       FROM session_summary_snapshots sss
       WHERE sss.session_id = ANY($1)
       ORDER BY sss.created_at ASC`,
      [sessionDbIds]
    );

    // Fetch compaction summary chunks for these sessions
    const compactions = await query<{
      session_id: string;
      chunk_id: string;
      chunk_index: number;
    }>(
      `SELECT s.id::text as session_id, sc.id as chunk_id, sc.chunk_index
       FROM session_chunks sc
       JOIN sessions s ON s.id = sc.session_id
       WHERE sc.session_id = ANY($1)
         AND sc.content LIKE 'User: This session is being continued%'
       ORDER BY sc.chunk_index ASC`,
      [sessionDbIds]
    );

    // Check which sessions are currently live
    const liveRows = await query<{ session_id: string; pid: number | null; last_seen_at: string }>(
      `SELECT session_id, pid, last_seen_at::text
       FROM active_sessions
       WHERE nickname = $1 AND status = 'active'`,
      [normalizedNickname]
    );
    const liveMap = new Map(liveRows.map(r => [r.session_id, r]));

    // Group snapshots and compactions by session
    const snapshotsBySession = new Map<string, typeof snapshots>();
    for (const snap of snapshots) {
      if (!snapshotsBySession.has(snap.session_id)) snapshotsBySession.set(snap.session_id, []);
      snapshotsBySession.get(snap.session_id)!.push(snap);
    }
    const compactionsBySession = new Map<string, typeof compactions>();
    for (const comp of compactions) {
      if (!compactionsBySession.has(comp.session_id)) compactionsBySession.set(comp.session_id, []);
      compactionsBySession.get(comp.session_id)!.push(comp);
    }

    const result = sessions.map(s => {
      const live = liveMap.get(s.session_id);
      return {
        session_id: s.session_id,
        session_db_id: s.id,
        status: live ? 'active' : 'inactive',
        project: s.project_id ? { handle: s.project_handle, name: s.project_name } : null,
        assistant: s.assistant_handle,
        message_count: s.message_count,
        started_at: s.started_at,
        ended_at: s.ended_at,
        is_live: !!live,
        pid: live?.pid ?? null,
        last_seen_at: live?.last_seen_at ?? null,
        summaries: (snapshotsBySession.get(s.id) || []).map(snap => ({
          snapshot_id: snap.snapshot_id,
          created_at: snap.created_at,
          chunk_count: snap.chunk_count,
        })),
        compactions: (compactionsBySession.get(s.id) || []).map(comp => ({
          chunk_id: comp.chunk_id,
          chunk_index: comp.chunk_index,
        })),
      };
    });

    return {
      nickname: normalizedNickname,
      sessions: result,
      total: result.length,
      live_count: liveRows.length,
    };
  });

  /**
   * GET /api/sessions/by-nickname/:nickname/token-count - Estimated token cost to rehydrate a lineage
   * Returns byte totals and a token estimate (bytes/4) for all summary snapshots and compaction
   * chunks across the lineage. Pure aggregate query — no file writes, no content fetch.
   */
  fastify.get('/by-nickname/:nickname/token-count', async (
    request: FastifyRequest<{ Params: { nickname: string } }>,
    reply: FastifyReply
  ) => {
    const normalizedNickname = request.params.nickname.toLowerCase().trim();

    const rows = await query<{
      total_bytes: string;
      session_count: string;
      summary_count: string;
      compaction_count: string;
    }>(
      `WITH sess AS (
         SELECT id FROM sessions WHERE nickname = $1
       ),
       snap AS (
         SELECT COALESCE(SUM(octet_length(content)), 0)::bigint AS b,
                COUNT(*)::int AS n
           FROM session_summary_snapshots
          WHERE session_id IN (SELECT id FROM sess)
       ),
       comp AS (
         SELECT COALESCE(SUM(octet_length(content)), 0)::bigint AS b,
                COUNT(*)::int AS n
           FROM session_chunks
          WHERE session_id IN (SELECT id FROM sess)
            AND content LIKE 'User: This session is being continued%'
       )
       SELECT ((SELECT b FROM snap) + (SELECT b FROM comp))::text AS total_bytes,
              (SELECT COUNT(*) FROM sess)::text AS session_count,
              (SELECT n FROM snap)::text AS summary_count,
              (SELECT n FROM comp)::text AS compaction_count`,
      [normalizedNickname]
    );

    const row = rows[0];
    const sessionCount = Number(row?.session_count ?? 0);

    if (sessionCount === 0) {
      return reply.status(404).send({ error: 'No sessions found with this nickname' });
    }

    const totalBytes = Number(row?.total_bytes ?? 0);

    return {
      nickname: normalizedNickname,
      total_bytes: totalBytes,
      estimated_tokens: Math.round(totalBytes / 4),
      session_count: sessionCount,
      summary_count: Number(row?.summary_count ?? 0),
      compaction_count: Number(row?.compaction_count ?? 0),
    };
  });

  /**
   * POST /api/sessions/by-nickname/:nickname/export - Export lineage summaries and compactions to disk
   */
  fastify.post('/by-nickname/:nickname/export', async (
    request: FastifyRequest<{ Params: { nickname: string }; Body: { path?: string } }>,
    reply: FastifyReply
  ) => {
    const { nickname } = request.params;
    const normalizedNickname = nickname.toLowerCase().trim();
    const basePath = request.body?.path || `tmp/lineage/${normalizedNickname}`;

    const fs = await import('fs');
    const pathLib = await import('path');
    const resolvedBase = pathLib.resolve(basePath);

    // Find all sessions with this nickname, chronologically
    const sessions = await query<{
      id: string;
      session_id: string;
      project_handle: string | null;
      assistant_handle: string;
      message_count: number | null;
      started_at: string | null;
      ended_at: string | null;
    }>(
      `SELECT s.id, s.session_id,
              p.handle as project_handle,
              a.handle as assistant_handle,
              s.message_count, s.started_at, s.ended_at
       FROM sessions s
       JOIN assistants a ON a.id = s.assistant_id
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE s.nickname = $1
       ORDER BY s.started_at ASC NULLS LAST`,
      [normalizedNickname]
    );

    if (sessions.length === 0) {
      return reply.status(404).send({ error: 'No sessions found with this nickname' });
    }

    const sessionDbIds = sessions.map(s => s.id);

    // Fetch all summary snapshot content
    const snapshots = await query<{
      session_id: string;
      snapshot_id: string;
      content: string;
      created_at: string;
      chunk_count: number | null;
    }>(
      `SELECT sss.session_id::text, sss.id as snapshot_id, sss.content, sss.created_at, sss.chunk_count
       FROM session_summary_snapshots sss
       WHERE sss.session_id = ANY($1)
       ORDER BY sss.created_at ASC`,
      [sessionDbIds]
    );

    // Fetch compaction summary chunk content
    const compactions = await query<{
      session_id: string;
      chunk_id: string;
      chunk_index: number;
      content: string;
    }>(
      `SELECT s.id::text as session_id, sc.id as chunk_id, sc.chunk_index, sc.content
       FROM session_chunks sc
       JOIN sessions s ON s.id = sc.session_id
       WHERE sc.session_id = ANY($1)
         AND sc.content LIKE 'User: This session is being continued%'
       ORDER BY sc.chunk_index ASC`,
      [sessionDbIds]
    );

    // Group by session
    const snapshotsBySession = new Map<string, typeof snapshots>();
    for (const snap of snapshots) {
      if (!snapshotsBySession.has(snap.session_id)) snapshotsBySession.set(snap.session_id, []);
      snapshotsBySession.get(snap.session_id)!.push(snap);
    }
    const compactionsBySession = new Map<string, typeof compactions>();
    for (const comp of compactions) {
      if (!compactionsBySession.has(comp.session_id)) compactionsBySession.set(comp.session_id, []);
      compactionsBySession.get(comp.session_id)!.push(comp);
    }

    // Write to disk
    fs.mkdirSync(resolvedBase, { recursive: true });

    const fileList: string[] = [];
    let totalContentBytes = 0;

    // Write lineage metadata
    const lineageMeta = {
      nickname: normalizedNickname,
      exported_at: new Date().toISOString(),
      sessions: sessions.map((s, i) => ({
        index: i,
        session_id: s.session_id,
        project: s.project_handle,
        assistant: s.assistant_handle,
        message_count: s.message_count,
        started_at: s.started_at,
        ended_at: s.ended_at,
        summary_count: (snapshotsBySession.get(s.id) || []).length,
        compaction_count: (compactionsBySession.get(s.id) || []).length,
      })),
    };
    const metaFile = pathLib.join(resolvedBase, '00-lineage.json');
    fs.writeFileSync(metaFile, JSON.stringify(lineageMeta, null, 2));
    fileList.push(metaFile);

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const prefix = String(i + 1).padStart(2, '0');
      const shortId = s.session_id.split('-')[0];
      const sessionDir = pathLib.join(resolvedBase, `${prefix}-${shortId}`);
      fs.mkdirSync(sessionDir, { recursive: true });

      const sessionSnaps = snapshotsBySession.get(s.id) || [];
      for (let j = 0; j < sessionSnaps.length; j++) {
        const snap = sessionSnaps[j];
        const snapFile = pathLib.join(sessionDir, `summary-${j + 1}-${snap.snapshot_id.split('-')[0]}.md`);
        const header = `<!-- Session: ${s.session_id} | Snapshot: ${snap.snapshot_id} | Created: ${snap.created_at} -->\n\n`;
        const snapContent = header + snap.content;
        fs.writeFileSync(snapFile, snapContent);
        totalContentBytes += Buffer.byteLength(snapContent, 'utf8');
        fileList.push(snapFile);
      }

      const sessionComps = compactionsBySession.get(s.id) || [];
      for (let j = 0; j < sessionComps.length; j++) {
        const comp = sessionComps[j];
        const compFile = pathLib.join(sessionDir, `compaction-${j + 1}-chunk${comp.chunk_index}.md`);
        const compHeader = `<!-- Session: ${s.session_id} | Chunk: ${comp.chunk_id} | Index: ${comp.chunk_index} -->\n\n`;
        const compContent = compHeader + comp.content;
        fs.writeFileSync(compFile, compContent);
        totalContentBytes += Buffer.byteLength(compContent, 'utf8');
        fileList.push(compFile);
      }
    }

    return {
      nickname: normalizedNickname,
      path: resolvedBase,
      sessions: sessions.length,
      files: fileList.length,
      file_list: fileList,
      total_content_bytes: totalContentBytes,
      estimated_tokens: Math.round(totalContentBytes / 4),
    };
  });

  /**
   * POST /api/sessions/grep - Raw JSONL grep across session transcripts on disk.
   *
   * Bypasses the indexed session_chunks table to search the full session JSONL content
   * (including tool_result blocks that are normally stripped at index time). Requires at
   * least one scope filter: session_id, nickname, or project_dir.
   */
  fastify.post('/grep', async (
    request: FastifyRequest<{ Body: GrepOptions }>,
    reply: FastifyReply
  ) => {
    const body = request.body ?? ({} as GrepOptions);
    if (!body.pattern || typeof body.pattern !== 'string' || !body.pattern.trim()) {
      return reply.code(400).send({ error: 'pattern is required' });
    }
    try {
      const result = await grepSessions(body);
      return result;
    } catch (err: any) {
      const msg = err?.message || 'grep failed';
      const code = msg.startsWith('Session not found') || msg.startsWith('No on-disk') || msg.startsWith('Project directory') || msg.includes('No session files')
        ? 404
        : 400;
      return reply.code(code).send({ error: msg });
    }
  });
}
