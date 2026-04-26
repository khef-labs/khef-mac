import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { TEST_DATABASE_URL } from '../setup';

// Set env before importing routes so db client uses correct URL
process.env.DATABASE_URL = TEST_DATABASE_URL;

import tagRoutes from '../../src/routes/tags';

describe('Tags q filter', () => {
  let app: FastifyInstance;
  let client: Client;

  beforeAll(async () => {
    app = Fastify();
    app.register(tagRoutes, { prefix: '/api/tags' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE tags CASCADE');
    await client.query("INSERT INTO tags (name) VALUES ('git'),('github'),('redis'),('cache')");
  });

  it('filters tags by case-insensitive partial match', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tags?q=GIT' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const names = body.tags.map((t: any) => t.name).sort();
    expect(names).toEqual(['git', 'github']);
  });
});

