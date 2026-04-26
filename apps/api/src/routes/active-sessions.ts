/**
 * Active sessions routes.
 * OS-level detection of currently open Claude Code / Codex CLI sessions.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  scanActiveSessions,
  refreshActiveSessionsCache,
  getCachedActiveSessions,
  getActiveSessionBySessionId,
  heartbeatSession,
  assignNickname,
  terminateSession,
  deactivateSession,
  formatActiveSession,
} from '../services/active-sessions';

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

    const rows = await getCachedActiveSessions({ assistant, project_id, status });

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

    await heartbeatSession(session_id, file_path, pid, terminal_session_id);

    return reply.status(204).send();
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
}
