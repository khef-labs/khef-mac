import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { setupTestDb, TEST_DATABASE_URL } from '../setup';

process.env.DATABASE_URL = TEST_DATABASE_URL;

import projectRoutes from '../../src/routes/projects';
import projectMemoryRoutes from '../../src/routes/project-memories';
import relationRoutes from '../../src/routes/relations';
import tagRoutes from '../../src/routes/tags';
import statsRoutes from '../../src/routes/stats';

describe('Stats Endpoint', () => {
  let app: FastifyInstance;
  let client: Client;

  beforeAll(async () => {
    await setupTestDb();

    app = Fastify();
    app.register(projectRoutes, { prefix: '/api/projects' });
    app.register(projectMemoryRoutes, { prefix: '/api/projects/:projectId/memories' });
    app.register(relationRoutes, { prefix: '/api/relations' });
    app.register(tagRoutes, { prefix: '/api/tags' });
    app.register(statsRoutes, { prefix: '/api/stats' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE projects CASCADE');
  });

  it('should return 200 with expected top-level keys', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty('memories');
    expect(body).toHaveProperty('projects');
    expect(body).toHaveProperty('tags');
    expect(body).toHaveProperty('relations');
    expect(body).toHaveProperty('files');
    expect(body).toHaveProperty('database');
  });

  it('should return correct shape for empty database', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats' });
    const body = JSON.parse(res.payload);

    expect(body.memories.total).toBe(0);
    expect(body.memories.by_type).toBeInstanceOf(Array);
    expect(body.memories.by_project).toBeInstanceOf(Array);
    expect(body.memories.oldest).toBeNull();
    expect(body.memories.newest).toBeNull();

    expect(body.projects.total).toBe(0);

    expect(body.tags.total).toBe(0);
    expect(body.tags.top).toEqual([]);

    expect(body.relations.total).toBe(0);
    expect(body.relations.by_type).toEqual([]);

    expect(body.files.total).toBe(0);
    expect(body.files.total_size).toBe(0);

    expect(body.database.size).toBeGreaterThan(0);
    expect(typeof body.database.size_human).toBe('string');
  });

  it('should reflect seeded data counts', async () => {
    // Create a project
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Stats Test Project' },
    });
    const projectId = JSON.parse(projRes.payload).project.id;

    // Create memories of different types
    const memA = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: { handle: 'dec-1', title: 'Decision 1', content: 'A decision', type: 'decision', tags: ['api'] },
    });
    const aId = JSON.parse(memA.payload).memory.id;

    const memB = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: { handle: 'pat-1', title: 'Pattern 1', content: 'A pattern', type: 'pattern', tags: ['api'] },
    });
    const bId = JSON.parse(memB.payload).memory.id;

    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: { handle: 'note-1', title: 'Note 1', content: 'A note', type: 'user-note' },
    });

    // Create a relation
    await app.inject({
      method: 'POST',
      url: '/api/relations',
      payload: { source_memory_id: aId, target_memory_id: bId, relation_type: 'supports' },
    });

    // Fetch stats
    const res = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    // Memory totals
    expect(body.memories.total).toBe(3);
    expect(body.memories.oldest).not.toBeNull();
    expect(body.memories.newest).not.toBeNull();

    // by_type uses type names, not IDs
    const decisionType = body.memories.by_type.find((t: any) => t.type === 'decision');
    expect(decisionType).toBeDefined();
    expect(decisionType.count).toBe(1);

    const patternType = body.memories.by_type.find((t: any) => t.type === 'pattern');
    expect(patternType).toBeDefined();
    expect(patternType.count).toBe(1);

    // by_project
    const proj = body.memories.by_project.find((p: any) => p.handle === 'stats-test-project');
    expect(proj).toBeDefined();
    expect(proj.count).toBe(3);

    // Projects
    expect(body.projects.total).toBe(1);

    // Tags (api tag used on 2 memories)
    expect(body.tags.total).toBeGreaterThanOrEqual(1);
    const apiTag = body.tags.top.find((t: any) => t.name === 'api');
    expect(apiTag).toBeDefined();
    expect(apiTag.count).toBe(2);

    // Relations
    expect(body.relations.total).toBe(1);
    const supportsRel = body.relations.by_type.find((r: any) => r.type === 'supports');
    expect(supportsRel).toBeDefined();
    expect(supportsRel.count).toBe(1);

    // Database size is positive
    expect(body.database.size).toBeGreaterThan(0);
  });

  it('should include all memory types in by_type even with zero count', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats' });
    const body = JSON.parse(res.payload);

    // Should include standard types like decision, pattern, user-note, etc.
    const typeNames = body.memories.by_type.map((t: any) => t.type);
    expect(typeNames).toContain('decision');
    expect(typeNames).toContain('pattern');
    expect(typeNames).toContain('user-note');
    expect(typeNames).toContain('assistant-todo');
  });
});
