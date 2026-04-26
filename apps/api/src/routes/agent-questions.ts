import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  createQuestion,
  getQuestion,
  getQuestionWithAnswer,
  answerQuestion,
  cancelQuestion,
  listPendingQuestions,
  countPendingQuestions,
  waitForResolution,
  ValidationError,
  type CreateQuestionInput,
} from '../services/agent-questions';
import { isRedisHealthy } from '../services/redis';

interface CreateBody extends CreateQuestionInput {}

interface AnswerBody {
  values?: unknown;
}

interface ListQuery {
  nickname?: string;
  limit?: string;
}

export default async function agentQuestionRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async (_request, reply) => {
    const healthy = await isRedisHealthy();
    if (!healthy) {
      return reply.status(503).send({ status: 'unavailable', error: 'Redis not connected' });
    }
    return { status: 'ok' };
  });

  fastify.post('/', async (
    request: FastifyRequest<{ Body: CreateBody }>,
    reply: FastifyReply,
  ) => {
    try {
      const question = await createQuestion(request.body ?? ({} as CreateBody));
      return reply.status(201).send({ question });
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }
  });

  fastify.get('/', async (
    request: FastifyRequest<{ Querystring: ListQuery }>,
  ) => {
    const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
    const nickname = request.query.nickname?.trim() || undefined;
    const questions = await listPendingQuestions({
      nickname,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return { questions, count: questions.length };
  });

  fastify.get('/count', async (
    request: FastifyRequest<{ Querystring: ListQuery }>,
  ) => {
    const nickname = request.query.nickname?.trim() || undefined;
    const count = await countPendingQuestions(nickname);
    return { count };
  });

  fastify.get('/:id', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await getQuestionWithAnswer(request.params.id);
    if (!result) return reply.status(404).send({ error: 'question not found or expired' });
    return result;
  });

  fastify.post('/:id/answer', async (
    request: FastifyRequest<{ Params: { id: string }; Body: AnswerBody }>,
    reply: FastifyReply,
  ) => {
    try {
      const answer = await answerQuestion(request.params.id, request.body?.values);
      return reply.status(201).send({ answer });
    } catch (err) {
      if (err instanceof ValidationError) {
        const status = err.message === 'question not found or expired' ? 404 : 400;
        return reply.status(status).send({ error: err.message });
      }
      throw err;
    }
  });

  fastify.delete('/:id', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const ok = await cancelQuestion(request.params.id);
    if (!ok) {
      const existing = await getQuestion(request.params.id);
      if (!existing) return reply.status(404).send({ error: 'question not found or expired' });
      return reply.status(409).send({ error: `question is already ${existing.status}` });
    }
    return { canceled: true };
  });

  // Long-poll wait for a single question to resolve.
  // GET /api/agent-questions/:id/wait?timeout_ms=600000
  fastify.get('/:id/wait', async (
    request: FastifyRequest<{
      Params: { id: string };
      Querystring: { timeout_ms?: string };
    }>,
    reply: FastifyReply,
  ) => {
    const timeoutMs = request.query.timeout_ms
      ? Math.min(Math.max(parseInt(request.query.timeout_ms, 10), 100), 3_600_000)
      : 600_000;
    const event = await waitForResolution(request.params.id, timeoutMs);
    if (event.type === 'question.answered') {
      return { status: 'answered', answer: event.answer ?? null, question: event.question ?? null };
    }
    if (event.type === 'question.canceled') {
      return reply.status(410).send({ status: 'canceled', question: event.question ?? null });
    }
    return reply.status(408).send({ status: 'expired' });
  });

  // SSE delivery is handled by the unified `/api/sse` route. Subscribe to room
  // `agent-questions` (broadcast) or `agent-questions:<nickname>` (filtered).
}
