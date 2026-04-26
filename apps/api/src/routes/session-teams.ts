import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  listTeams,
  getTeam,
  getTeamMembers,
  createTeam,
  updateTeam,
  deleteTeam,
  addMembers,
  removeMember,
  reorderMembers,
  broadcastToTeam,
} from '../services/session-teams';
import { sendLiveMessage, deliverViaIterm } from '../services/live-messages';
import { getActiveSessionBySessionId } from '../services/active-sessions';

export default async function sessionTeamRoutes(fastify: FastifyInstance) {
  // GET /api/session-teams
  fastify.get('/', async (
    request: FastifyRequest<{ Querystring: { project?: string } }>,
    _reply: FastifyReply
  ) => {
    const teams = await listTeams(request.query.project);
    return { teams };
  });

  // POST /api/session-teams
  fastify.post('/', async (
    request: FastifyRequest<{ Body: { name: string; description?: string; project?: string } }>,
    reply: FastifyReply
  ) => {
    const { name, description, project } = request.body ?? {};
    if (!name) return reply.status(400).send({ error: 'name is required' });

    const team = await createTeam(name, description, project);
    return reply.status(201).send({ team });
  });

  // GET /api/session-teams/:id
  fastify.get('/:id', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const team = await getTeam(request.params.id);
    if (!team) return reply.status(404).send({ error: 'Team not found' });

    const members = await getTeamMembers(request.params.id);
    return { team, members };
  });

  // PATCH /api/session-teams/:id
  fastify.patch('/:id', async (
    request: FastifyRequest<{ Params: { id: string }; Body: { name?: string; description?: string } }>,
    reply: FastifyReply
  ) => {
    const team = await updateTeam(request.params.id, request.body ?? {});
    if (!team) return reply.status(404).send({ error: 'Team not found' });
    return { team };
  });

  // DELETE /api/session-teams/:id
  fastify.delete('/:id', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    await deleteTeam(request.params.id);
    return reply.status(204).send();
  });

  // POST /api/session-teams/:id/members
  fastify.post('/:id/members', async (
    request: FastifyRequest<{ Params: { id: string }; Body: { session_ids: string[] } }>,
    reply: FastifyReply
  ) => {
    const { session_ids } = request.body ?? {};
    if (!session_ids?.length) return reply.status(400).send({ error: 'session_ids is required' });

    const team = await getTeam(request.params.id);
    if (!team) return reply.status(404).send({ error: 'Team not found' });

    const added = await addMembers(request.params.id, session_ids);
    return reply.status(201).send({ added });
  });

  // PATCH /api/session-teams/:id/reorder
  fastify.patch('/:id/reorder', async (
    request: FastifyRequest<{ Params: { id: string }; Body: { session_ids: string[] } }>,
    reply: FastifyReply
  ) => {
    const { session_ids } = request.body ?? {};
    if (!session_ids?.length) return reply.status(400).send({ error: 'session_ids is required' });

    const team = await getTeam(request.params.id);
    if (!team) return reply.status(404).send({ error: 'Team not found' });

    await reorderMembers(request.params.id, session_ids);
    return { reordered: true };
  });

  // DELETE /api/session-teams/:id/members/:sessionId
  fastify.delete('/:id/members/:sessionId', async (
    request: FastifyRequest<{ Params: { id: string; sessionId: string } }>,
    reply: FastifyReply
  ) => {
    await removeMember(request.params.id, request.params.sessionId);
    return reply.status(204).send();
  });

  // POST /api/session-teams/:id/broadcast
  fastify.post('/:id/broadcast', async (
    request: FastifyRequest<{
      Params: { id: string };
      Body: { content: string; from_session_id?: string }
    }>,
    reply: FastifyReply
  ) => {
    const { content, from_session_id } = request.body ?? {};
    if (!content) return reply.status(400).send({ error: 'content is required' });

    const fromId = from_session_id || 'khef-ui';
    const recipientIds = await broadcastToTeam(request.params.id, fromId, content);

    if (recipientIds.length === 0) {
      return { messages: [], recipients: 0 };
    }

    // Send via Redis + iTerm2 delivery
    const messages = await Promise.all(
      recipientIds.map(toId => sendLiveMessage(fromId, toId, content))
    );

    // Best-effort iTerm2 delivery
    const nudge = `Team broadcast from ${fromId}. Use check_live_messages to read it.`;
    Promise.all(
      recipientIds.map(async (toId) => {
        try {
          const session = await getActiveSessionBySessionId(toId);
          if (session?.terminal_session_id) {
            await deliverViaIterm(session.terminal_session_id, nudge);
          }
        } catch {}
      })
    ).catch(() => {});

    return reply.status(201).send({ messages, recipients: messages.length });
  });
}
