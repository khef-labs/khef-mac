/**
 * Active sessions routes.
 * OS-level detection of currently open Claude Code / Codex CLI sessions.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as os from 'os';
import * as path from 'path';
import {
  scanActiveSessions,
  refreshActiveSessionsCache,
  getCachedActiveSessions,
  getCachedActiveSessionsWithLiveness,
  getActiveSessionBySessionId,
  getActiveSessionByPid,
  heartbeatSession,
  assignNickname,
  registerCodexSessionFile,
  terminateSession,
  deactivateSession,
  formatActiveSession,
} from '../services/active-sessions';

const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

interface ActiveSessionsQuery {
  assistant?: string;
  project_id?: string;
  status?: string;
}

export default async function activeSessionRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/active-sessions - List active sessions from cache
   */
  fastify.get('/', async (
    request: FastifyRequest<{ Querystring: ActiveSessionsQuery }>,
    reply: FastifyReply
  ) => {
    const { assistant, project_id, status } = request.query;

    const rows = await getCachedActiveSessionsWithLiveness({ assistant, project_id, status });

    return {
      sessions: rows.map(formatActiveSession),
      count: rows.length,
    };
  });

  /**
   * POST /api/active-sessions/scan - Trigger OS scan and refresh cache
   */
  fastify.post('/scan', async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    const scanned = await scanActiveSessions({ forceFuser: true });
    await refreshActiveSessionsCache(scanned);

    const rows = await getCachedActiveSessions({ status: 'active' });

    return {
      sessions: rows.map(formatActiveSession),
      count: rows.length,
      scanned_count: scanned.length,
    };
  });

  /**
   * POST /api/active-sessions/heartbeat - Register/refresh a session via hook
   */
  fastify.post('/heartbeat', async (
    request: FastifyRequest<{ Body: { session_id: string; file_path: string; pid?: number; terminal_session_id?: string } }>,
    reply: FastifyReply
  ) => {
    const { session_id, file_path, pid, terminal_session_id } = request.body ?? {};

    if (!session_id || !file_path) {
      return reply.status(400).send({ error: 'session_id and file_path are required' });
    }

    await heartbeatSession(session_id, file_path, { pid, terminalSessionId: terminal_session_id });

    return reply.status(204).send();
  });

  /**
   * POST /api/active-sessions/register-codex - Register a Codex session by file path.
   * Reads session_meta.payload.id from the JSONL so registration uses the real
   * Codex session UUID rather than a synthetic one. Used by the Codex wrapper
   * once it discovers the freshly-created transcript on disk.
   */
  fastify.post('/register-codex', async (
    request: FastifyRequest<{ Body: {
      file_path: string;
      pid?: number;
      terminal_session_id?: string;
      assign_nickname?: boolean;
      sync_transcript?: boolean;
    } }>,
    reply: FastifyReply
  ) => {
    const body = request.body ?? ({} as any);
    const { file_path, pid, terminal_session_id, assign_nickname, sync_transcript } = body;

    if (!file_path) {
      return reply.status(400).send({ error: 'file_path is required' });
    }

    const resolved = path.resolve(file_path.startsWith('~')
      ? path.join(os.homedir(), file_path.slice(1))
      : file_path);
    if (!resolved.startsWith(CODEX_SESSIONS_ROOT + path.sep)) {
      return reply.status(400).send({ error: `file_path must be inside ${CODEX_SESSIONS_ROOT}` });
    }

    try {
      const result = await registerCodexSessionFile(resolved, {
        pid,
        terminalSessionId: terminal_session_id,
        assignNickname: assign_nickname,
        syncTranscript: sync_transcript,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: message });
    }
  });

  /**
   * POST /api/active-sessions/:sessionId/terminate - Send SIGTERM to a session's PID
   */
  fastify.post('/:sessionId/terminate', async (
    request: FastifyRequest<{ Params: { sessionId: string } }>,
    reply: FastifyReply
  ) => {
    const { sessionId } = request.params;

    const result = await terminateSession(sessionId);

    if (!result.pid) {
      return reply.status(404).send({ error: 'No active session with a known PID found' });
    }

    if (!result.terminated) {
      return reply.status(410).send({ error: 'Session PID was already dead', pid: result.pid });
    }

    return { terminated: true, pid: result.pid };
  });

  /**
   * POST /api/active-sessions/:sessionId/deactivate - Mark session as inactive
   * Called by the SessionEnd hook when a Claude Code session exits.
   */
  fastify.post('/:sessionId/deactivate', async (
    request: FastifyRequest<{ Params: { sessionId: string } }>,
    reply: FastifyReply
  ) => {
    const { sessionId } = request.params;
    const deactivated = await deactivateSession(sessionId);

    if (!deactivated) {
      return reply.status(404).send({ error: 'No active session found' });
    }

    return reply.status(204).send();
  });

  /**
   * POST /api/active-sessions/:sessionId/nickname - Assign or claim a nickname
   * Body: { nickname?: string } — if provided, claims that name (allows sharing)
   */
  fastify.post('/:sessionId/nickname', async (
    request: FastifyRequest<{ Params: { sessionId: string }; Body: { nickname?: string } }>,
    reply: FastifyReply
  ) => {
    const { sessionId } = request.params;
    const requestedNickname = request.body?.nickname;
    const nickname = await assignNickname(sessionId, requestedNickname);

    if (nickname === null) {
      return reply.status(404).send({ error: 'Session not registered yet — heartbeat first' });
    }

    return { nickname };
  });

  /**
   * GET /api/active-sessions/by-session-id/:sessionId - Lookup by session UUID
   */
  fastify.get('/by-session-id/:sessionId', async (
    request: FastifyRequest<{ Params: { sessionId: string } }>,
    reply: FastifyReply
  ) => {
    const { sessionId } = request.params;

    const row = await getActiveSessionBySessionId(sessionId);
    if (!row) {
      return reply.status(404).send({ error: 'Active session not found' });
    }

    return { session: formatActiveSession(row) };
  });

  /**
   * GET /api/active-sessions/by-pid/:pid - Lookup by OS PID
   *
   * Used by the MCP server's current-session resolver as a fallback when
   * neither KHEF_SESSION_ID nor the iTerm2 terminal session ID identify the
   * caller. The MCP server walks its own ancestor PIDs (process.ppid, ppid of
   * ppid, ...) and asks this endpoint to match each one. Returns the most
   * recently-seen active session attached to that PID.
   */
  fastify.get('/by-pid/:pid', async (
    request: FastifyRequest<{ Params: { pid: string } }>,
    reply: FastifyReply
  ) => {
    const pid = Number.parseInt(request.params.pid, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return reply.status(400).send({ error: 'pid must be a positive integer' });
    }

    const row = await getActiveSessionByPid(pid);
    if (!row) {
      return reply.status(404).send({ error: 'Active session not found for PID' });
    }

    return { session: formatActiveSession(row) };
  });
}
