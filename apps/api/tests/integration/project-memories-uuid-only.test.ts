import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { TEST_DATABASE_URL } from '../setup';

process.env.DATABASE_URL = TEST_DATABASE_URL;

import projectRoutes from '../../src/routes/projects';
import projectMemoryRoutes from '../../src/routes/project-memories';

describe('Project memories UUID-only enforcement', () => {
  let app: FastifyInstance;
  let client: Client;
  let projectId: string;

  beforeAll(async () => {
    app = Fastify();
    app.register(projectRoutes, { prefix: '/api/projects' });
    app.register(projectMemoryRoutes, { prefix: '/api/projects/:projectId/memories' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE projects CASCADE');
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'UUID Only' } });
    projectId = JSON.parse(res.payload).project.id;
  });

  it('rejects non-UUID projectId in path', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/khef/memories' });
    expect(res.statusCode).toBe(400);
  });

  it('accepts UUID projectId and q param', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/memories?q=test` });
    expect(res.statusCode).toBe(200);
  });

  it('rejects non-UUID memory id in path', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/memories/not-a-uuid` });
    expect(res.statusCode).toBe(400);
  });
});

