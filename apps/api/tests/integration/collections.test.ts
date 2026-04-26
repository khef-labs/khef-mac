import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { TEST_DATABASE_URL } from '../setup';

process.env.DATABASE_URL = TEST_DATABASE_URL;

import collectionRoutes, { globalCollectionsRoute, memoryCollectionsRoute } from '../../src/routes/collections';

describe('Collections', () => {
  let app: FastifyInstance;
  let client: Client;
  let projectA: string;
  let projectB: string;
  let memoryA: string;
  let memoryB: string;
  let collectionA: string;
  let collectionB: string;

  beforeAll(async () => {
    app = Fastify();
    app.register(collectionRoutes, { prefix: '/api/projects/:projectId/collections' });
    app.register(globalCollectionsRoute, { prefix: '/api/collections' });
    app.register(memoryCollectionsRoute, { prefix: '/api/projects/:projectId/memories/:memoryId/collections' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE collection_memories, collections, memories, projects CASCADE');

    // Create two projects
    const projARes = await client.query(
      "INSERT INTO projects (handle, name, display_name) VALUES ('proj-a', 'Project A', 'Project A') RETURNING id"
    );
    projectA = projARes.rows[0].id;

    const projBRes = await client.query(
      "INSERT INTO projects (handle, name, display_name) VALUES ('proj-b', 'Project B', 'Project B') RETURNING id"
    );
    projectB = projBRes.rows[0].id;

    // Get a memory type and its default status
    const typeRow = await client.query("SELECT id FROM memory_types WHERE name = 'user-note' LIMIT 1");
    const typeId = typeRow.rows[0].id;
    const statusRow = await client.query(
      'SELECT id FROM memory_type_statuses WHERE memory_type_id = $1 AND sort_order = 0',
      [typeId]
    );
    const statusId = statusRow.rows[0].id;

    // Create a memory in each project
    const memARes = await client.query(
      'INSERT INTO memories (project_id, memory_type_id, status_id, handle, title, content) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [projectA, typeId, statusId, 'mem-a', 'Memory A', 'content a']
    );
    memoryA = memARes.rows[0].id;

    const memBRes = await client.query(
      'INSERT INTO memories (project_id, memory_type_id, status_id, handle, title, content) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [projectB, typeId, statusId, 'mem-b', 'Memory B', 'content b']
    );
    memoryB = memBRes.rows[0].id;

    // Create a collection in each project
    const colARes = await client.query(
      "INSERT INTO collections (project_id, handle, name) VALUES ($1, 'col-a', 'Collection A') RETURNING id",
      [projectA]
    );
    collectionA = colARes.rows[0].id;

    const colBRes = await client.query(
      "INSERT INTO collections (project_id, handle, name) VALUES ($1, 'col-b', 'Collection B') RETURNING id",
      [projectB]
    );
    collectionB = colBRes.rows[0].id;
  });

  describe('Global collections endpoint', () => {
    it('should return collections from all projects', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/collections' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.collections).toHaveLength(2);
      const handles = body.collections.map((c: any) => c.handle).sort();
      expect(handles).toEqual(['col-a', 'col-b']);
    });

    it('should include project metadata and memory count', async () => {
      await client.query(
        'INSERT INTO collection_memories (collection_id, memory_id, position) VALUES ($1, $2, 0)',
        [collectionA, memoryA]
      );

      const res = await app.inject({ method: 'GET', url: '/api/collections' });
      const body = JSON.parse(res.payload);
      const colA = body.collections.find((c: any) => c.handle === 'col-a');
      expect(colA.project_id).toBe(projectA);
      expect(colA.project_handle).toBe('proj-a');
      expect(colA.project_name).toBe('Project A');
      expect(colA.memory_count).toBe(1);
    });
  });

  describe('Cross-project add to collection', () => {
    it('should allow adding a memory from another project', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectA}/collections/${collectionA}/memories`,
        payload: { memory_id: memoryB },
      });
      expect(res.statusCode).toBe(201);
    });

    it('should reject adding a non-existent memory', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectA}/collections/${collectionA}/memories`,
        payload: { memory_id: '00000000-0000-0000-0000-000000000000' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toBe('Memory not found');
    });

    it('should return 409 for duplicate additions', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/projects/${projectA}/collections/${collectionA}/memories`,
        payload: { memory_id: memoryA },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectA}/collections/${collectionA}/memories`,
        payload: { memory_id: memoryA },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('Memory collections across projects', () => {
    it('should return collections from all projects for a memory', async () => {
      await client.query(
        'INSERT INTO collection_memories (collection_id, memory_id, position) VALUES ($1, $2, 0)',
        [collectionA, memoryA]
      );
      await client.query(
        'INSERT INTO collection_memories (collection_id, memory_id, position) VALUES ($1, $2, 0)',
        [collectionB, memoryA]
      );

      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectA}/memories/${memoryA}/collections`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.collections).toHaveLength(2);

      const handles = body.collections.map((c: any) => c.handle).sort();
      expect(handles).toEqual(['col-a', 'col-b']);
    });

    it('should include project metadata in response', async () => {
      await client.query(
        'INSERT INTO collection_memories (collection_id, memory_id, position) VALUES ($1, $2, 0)',
        [collectionB, memoryA]
      );

      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectA}/memories/${memoryA}/collections`,
      });
      const body = JSON.parse(res.payload);
      const col = body.collections[0];
      expect(col.project_id).toBe(projectB);
      expect(col.project_handle).toBe('proj-b');
      expect(col.project_name).toBe('Project B');
    });
  });
});
