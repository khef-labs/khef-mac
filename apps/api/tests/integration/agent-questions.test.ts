import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { TEST_DATABASE_URL } from '../setup';

process.env.DATABASE_URL = TEST_DATABASE_URL;

import agentQuestionRoutes from '../../src/routes/agent-questions';
import { closeRedis, getRedis, isRedisHealthy } from '../../src/services/redis';

// Probe Redis at module load — Vitest runs each file in its own worker, so
// this top-level await runs once before any tests register.
const redisAvailable = await (async () => {
  try {
    const ok = await isRedisHealthy();
    if (!ok) {
      // eslint-disable-next-line no-console
      console.warn('Redis unavailable — skipping agent-questions integration tests');
    }
    return ok;
  } catch {
    return false;
  }
})();

const describeIfRedis = redisAvailable ? describe : describe.skip;

async function flushAgentQuestionKeys() {
  const redis = getRedis();
  const keys = await redis.keys('aq:*');
  if (keys.length > 0) await redis.del(...keys);
}

describeIfRedis('Agent questions integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.register(agentQuestionRoutes, { prefix: '/api/agent-questions' });
    await app.ready();
    await flushAgentQuestionKeys();
  });

  afterAll(async () => {
    await app.close();
    await closeRedis();
  });

  afterEach(async () => {
    await flushAgentQuestionKeys();
  });

  it('creates a question and returns it via GET', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agent-questions',
      payload: {
        title: 'Pick an SSG',
        fields: [
          {
            key: 'gen',
            type: 'single-choice',
            label: 'Generator',
            required: true,
            options: [
              { value: 'astro', label: 'Astro' },
              { value: 'hugo', label: 'Hugo' },
            ],
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const { question } = JSON.parse(created.payload);
    expect(question.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(question.status).toBe('pending');

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/agent-questions/${question.id}`,
    });
    expect(fetched.statusCode).toBe(200);
    const body = JSON.parse(fetched.payload);
    expect(body.question.id).toBe(question.id);
    expect(body.answer).toBeNull();
  });

  it('auto-appends a "something_else" textarea when the last field is not already a textarea', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agent-questions',
      payload: {
        title: 'Catch-all test',
        fields: [
          {
            key: 'choice',
            type: 'single-choice',
            label: 'Pick',
            options: [
              { value: 'a', label: 'A' },
              { value: 'b', label: 'B' },
            ],
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const { question } = JSON.parse(created.payload);
    const last = question.fields[question.fields.length - 1];
    expect(question.fields.length).toBe(2);
    expect(last.key).toBe('something_else');
    expect(last.type).toBe('textarea');
    expect(last.required).toBeUndefined();
  });

  it('does not append "something_else" when the last field is already a textarea', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agent-questions',
      payload: {
        title: 'Already has notes',
        fields: [
          { key: 'name', type: 'text', label: 'Name' },
          { key: 'notes', type: 'textarea', label: 'Notes' },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const { question } = JSON.parse(created.payload);
    expect(question.fields.length).toBe(2);
    expect(question.fields[question.fields.length - 1].key).toBe('notes');
  });

  it('rejects malformed field schemas', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent-questions',
      payload: { title: 'Hi', fields: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/non-empty array/);
  });

  it('answers a question with validated values', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agent-questions',
      payload: {
        title: 'Pick a host',
        fields: [
          { key: 'host', type: 'text', label: 'Host', required: true },
          { key: 'tls', type: 'toggle', label: 'TLS' },
        ],
      },
    });
    const id = JSON.parse(created.payload).question.id;

    const bad = await app.inject({
      method: 'POST',
      url: `/api/agent-questions/${id}/answer`,
      payload: { values: { tls: true } },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST',
      url: `/api/agent-questions/${id}/answer`,
      payload: { values: { host: 'khef.com', tls: true } },
    });
    expect(ok.statusCode).toBe(201);
    const { answer } = JSON.parse(ok.payload);
    expect(answer.values).toEqual({ host: 'khef.com', tls: true });

    const after = await app.inject({
      method: 'GET',
      url: `/api/agent-questions/${id}`,
    });
    const body = JSON.parse(after.payload);
    expect(body.question.status).toBe('answered');
    expect(body.answer.values.host).toBe('khef.com');
  });

  it('cancels a pending question', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agent-questions',
      payload: {
        title: 'Untitled',
        fields: [{ key: 'a', type: 'text', label: 'A' }],
      },
    });
    const id = JSON.parse(created.payload).question.id;

    const canceled = await app.inject({
      method: 'DELETE',
      url: `/api/agent-questions/${id}`,
    });
    expect(canceled.statusCode).toBe(200);
    expect(JSON.parse(canceled.payload).canceled).toBe(true);

    const second = await app.inject({
      method: 'DELETE',
      url: `/api/agent-questions/${id}`,
    });
    expect(second.statusCode).toBe(409);
  });

  it('lists pending questions and excludes resolved ones', async () => {
    const a = await app.inject({
      method: 'POST',
      url: '/api/agent-questions',
      payload: {
        title: 'A',
        fields: [{ key: 'x', type: 'text', label: 'X' }],
      },
    });
    const aId = JSON.parse(a.payload).question.id;

    await app.inject({
      method: 'POST',
      url: '/api/agent-questions',
      payload: {
        title: 'B',
        fields: [{ key: 'x', type: 'text', label: 'X' }],
      },
    });

    const beforeList = await app.inject({
      method: 'GET',
      url: '/api/agent-questions',
    });
    const beforeBody = JSON.parse(beforeList.payload);
    expect(beforeBody.questions.length).toBeGreaterThanOrEqual(2);

    await app.inject({
      method: 'DELETE',
      url: `/api/agent-questions/${aId}`,
    });

    const afterList = await app.inject({
      method: 'GET',
      url: '/api/agent-questions',
    });
    const afterBody = JSON.parse(afterList.payload);
    const ids = afterBody.questions.map((q: any) => q.id);
    expect(ids).not.toContain(aId);
  });

  it(
    'returns 408 for wait when question expires before resolution',
    async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/agent-questions',
        payload: {
          title: 'Quick expire',
          ttl_seconds: 1,
          fields: [{ key: 'x', type: 'text', label: 'X' }],
        },
      });
      const id = JSON.parse(created.payload).question.id;

      const wait = await app.inject({
        method: 'GET',
        url: `/api/agent-questions/${id}/wait?timeout_ms=2000`,
      });
      expect(wait.statusCode).toBe(408);
    },
    15_000,
  );

  it('defaults to a 24h TTL when ttl_seconds is omitted', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agent-questions',
      payload: {
        title: 'Default expiry',
        fields: [{ key: 'x', type: 'text', label: 'X' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const { question } = JSON.parse(created.payload);
    expect(question.expires_at).toBeTruthy();
    const remainingSec = (new Date(question.expires_at).getTime() - Date.now()) / 1000;
    // Should be very close to 24h.
    expect(remainingSec).toBeGreaterThan(86000);
    expect(remainingSec).toBeLessThanOrEqual(86400);

    const ttl = await getRedis().ttl(`aq:question:${question.id}`);
    expect(ttl).toBeGreaterThan(86000);
    expect(ttl).toBeLessThanOrEqual(86400);
  });

  it('honors an explicit ttl_seconds with a real expiry', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agent-questions',
      payload: {
        title: 'Has expiry',
        ttl_seconds: 120,
        fields: [{ key: 'x', type: 'text', label: 'X' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const { question } = JSON.parse(created.payload);
    expect(question.expires_at).not.toBeNull();
    expect(new Date(question.expires_at).getTime()).toBeGreaterThan(Date.now());

    const ttl = await getRedis().ttl(`aq:question:${question.id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });
});
