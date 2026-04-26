import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { isRedisHealthy } from '../services/redis';
import { resolveSessionId, resolveSessionIds, findInactiveSession, getActiveSessionBySessionId } from '../services/active-sessions';
import {
  sendLiveMessage,
  checkLiveMessages,
  countLiveMessages,
  deleteLiveMessage,
  clearLiveMessages,
  deliverViaIterm,
} from '../services/live-messages';

interface SendBody {
  from_session_id: string;
  content: string;
  from_nickname?: string;
}

interface CheckQuery {
  limit?: string;
  peek?: string;
}

export default async function liveMessageRoutes(fastify: FastifyInstance) {
  // Health check
  fastify.get('/health', async (_request, reply) => {
    const healthy = await isRedisHealthy();
    if (!healthy) {
      return reply.status(503).send({ status: 'unavailable', error: 'Redis not connected' });
    }
    return { status: 'ok' };
  });

  // POST /api/live-messages/:sessionId — send a live message (broadcasts if nickname matches multiple sessions)
  fastify.post('/:sessionId', async (
    request: FastifyRequest<{ Params: { sessionId: string }; Body: SendBody }>,
    reply: FastifyReply
  ) => {
    const resolvedToIds = await resolveSessionIds(request.params.sessionId);
    if (resolvedToIds.length === 0) {
      const inactiveId = await findInactiveSession(request.params.sessionId);
      if (inactiveId) {
        return reply.status(404).send({
          error: `Session "${request.params.sessionId}" is inactive. Use wake_session to wake it first, then send your message.`,
          inactive_session_id: inactiveId,
        });
      }
      return reply.status(404).send({ error: 'Session not found' });
    }
    const { from_session_id, content, from_nickname } = request.body ?? {};

    if (!from_session_id || !content) {
      return reply.status(400).send({ error: 'from_session_id and content are required' });
    }

    const resolvedFrom = await resolveSessionId(from_session_id) || from_session_id;

    // Filter out self from recipients
    const recipients = resolvedToIds.filter(id => id !== resolvedFrom);
    if (recipients.length === 0) {
      return reply.status(400).send({ error: 'Cannot send a message to yourself' });
    }

    // Build the nudge payload. Short messages embed the full content so the
    // receiver can respond without calling check_live_messages. Long messages
    // include a short preview and direct the agent to read via the tool.
    const SHORT_THRESHOLD = 500;
    const PREVIEW_LEN = 140;
    const sender = from_nickname
      ? `${from_nickname} (${from_session_id})`
      : from_session_id;
    const flat = content.replace(/\s+/g, ' ').trim();
    const isShort = flat.length <= SHORT_THRESHOLD;
    const nudge = isShort
      ? (from_nickname ? `Live message from ${sender}: ${flat}` : `${flat}`)
      : `Message from ${sender}: ${flat.slice(0, PREVIEW_LEN)}… (use check_live_messages to read)`;

    // Per-recipient: attempt iTerm delivery synchronously so we can decide
    // whether Redis persistence is needed. Persist only when the nudge can't
    // carry the full payload (long message) or when iTerm delivery failed.
    const messages = await Promise.all(
      recipients.map(async (toId) => {
        let delivered = false;
        try {
          const session = await getActiveSessionBySessionId(toId);
          if (session?.terminal_session_id) {
            const result = await deliverViaIterm(session.terminal_session_id, nudge);
            delivered = result.delivered;
          }
        } catch {
          delivered = false;
        }
        const persist = !(isShort && delivered);
        return sendLiveMessage(resolvedFrom, toId, content, { persist });
      })
    );

    return reply.status(201).send({
      messages,
      recipients: messages.length,
    });
  });

  // GET /api/live-messages/:sessionId — check live messages (destructive read by default)
  fastify.get('/:sessionId', async (
    request: FastifyRequest<{ Params: { sessionId: string }; Querystring: CheckQuery }>,
    reply: FastifyReply
  ) => {
    const resolvedId = await resolveSessionId(request.params.sessionId);
    if (!resolvedId) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    const limit = Math.min(parseInt(request.query.limit || '50', 10), 100);
    const peek = request.query.peek === 'true';

    const messages = await checkLiveMessages(resolvedId, { limit, peek });
    return { messages, count: messages.length };
  });

  // GET /api/live-messages/:sessionId/count — count pending live messages
  fastify.get('/:sessionId/count', async (
    request: FastifyRequest<{ Params: { sessionId: string } }>,
    reply: FastifyReply
  ) => {
    const resolvedId = await resolveSessionId(request.params.sessionId);
    if (!resolvedId) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    const count = await countLiveMessages(resolvedId);
    return { count };
  });

  // DELETE /api/live-messages/:sessionId/messages/:messageId — recall a sent message
  fastify.delete('/:sessionId/messages/:messageId', async (
    request: FastifyRequest<{
      Params: { sessionId: string; messageId: string };
      Querystring: { from_session_id?: string };
    }>,
    reply: FastifyReply
  ) => {
    const resolvedTo = await resolveSessionId(request.params.sessionId);
    if (!resolvedTo) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const fromSessionId = request.query.from_session_id;
    if (!fromSessionId) {
      return reply.status(400).send({ error: 'from_session_id query param is required' });
    }

    const resolvedFrom = await resolveSessionId(fromSessionId) || fromSessionId;
    const result = await deleteLiveMessage(resolvedTo, request.params.messageId, resolvedFrom);

    if (!result.deleted) {
      return reply.status(404).send({ error: 'Message not found or not owned by sender' });
    }

    return { deleted: true, message: result.message };
  });

  // DELETE /api/live-messages/:sessionId — clear all live messages
  fastify.delete('/:sessionId', async (
    request: FastifyRequest<{ Params: { sessionId: string } }>,
    reply: FastifyReply
  ) => {
    const resolvedId = await resolveSessionId(request.params.sessionId);
    if (!resolvedId) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    const cleared = await clearLiveMessages(resolvedId);
    return { cleared };
  });
}
