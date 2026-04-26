import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { TEST_DATABASE_URL } from '../setup';

// Set env before importing routes so db client uses correct URL
process.env.DATABASE_URL = TEST_DATABASE_URL;

import memoryRoutes from '../../src/routes/memories';
import projectMemoryRoutes from '../../src/routes/project-memories';
import projectRoutes from '../../src/routes/projects';

describe('Memory Pinning', () => {
  let app: FastifyInstance;
  let client: Client;
  let testProjectId: string;

  beforeAll(async () => {
    app = Fastify();
    app.register(projectRoutes, { prefix: '/api/projects' });
    app.register(projectMemoryRoutes, { prefix: '/api/projects/:projectId/memories' });
    app.register(memoryRoutes, { prefix: '/api/memories' });
    await app.ready();

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE projects CASCADE');
    await client.query('TRUNCATE memory_metadata CASCADE');

    // Create test project
    const projectRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Pin Test Project', handle: 'pin-test' }
    });
    testProjectId = JSON.parse(projectRes.body).project.id;
  });

  async function createMemory(handle: string, title: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${testProjectId}/memories`,
      payload: { handle, title, content: `Content for ${title}`, type: 'context' }
    });
    return JSON.parse(res.body).memory.id;
  }

  async function pinMemory(memoryId: string) {
    return app.inject({
      method: 'PUT',
      url: `/api/memories/${memoryId}/metadata/is-pinned`,
      payload: { value: 'true' }
    });
  }

  async function unpinMemory(memoryId: string) {
    return app.inject({
      method: 'PUT',
      url: `/api/memories/${memoryId}/metadata/is-pinned`,
      payload: { value: 'false' }
    });
  }

  describe('Pin/unpin via metadata API', () => {
    it('should pin a memory via PUT metadata', async () => {
      const memoryId = await createMemory('mem-a', 'Memory A');
      const res = await pinMemory(memoryId);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.field).toBe('is-pinned');
      expect(body.value).toBe('true');
    });

    it('should unpin by setting value to false', async () => {
      const memoryId = await createMemory('mem-b', 'Memory B');
      await pinMemory(memoryId);
      const res = await unpinMemory(memoryId);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).value).toBe('false');
    });

    it('should unpin by deleting metadata', async () => {
      const memoryId = await createMemory('mem-c', 'Memory C');
      await pinMemory(memoryId);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/memories/${memoryId}/metadata/is-pinned`
      });
      expect(res.statusCode).toBe(204);
    });
  });

  describe('Project-scoped list with pinned filter', () => {
    it('should return only pinned memories with ?pinned=true', async () => {
      const id1 = await createMemory('mem-1', 'First');
      const id2 = await createMemory('mem-2', 'Second');
      await pinMemory(id1);

      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${testProjectId}/memories?pinned=true`
      });

      const body = JSON.parse(res.body);
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0].id).toBe(id1);
      expect(body.memories[0].is_pinned).toBe(true);
    });

    it('should return only unpinned memories with ?pinned=false', async () => {
      const id1 = await createMemory('mem-1', 'First');
      const id2 = await createMemory('mem-2', 'Second');
      await pinMemory(id1);

      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${testProjectId}/memories?pinned=false`
      });

      const body = JSON.parse(res.body);
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0].id).toBe(id2);
      expect(body.memories[0].is_pinned).toBe(false);
    });

    it('should include is_pinned in response without filter', async () => {
      const id1 = await createMemory('mem-1', 'First');
      await pinMemory(id1);
      await createMemory('mem-2', 'Second');

      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${testProjectId}/memories`
      });

      const body = JSON.parse(res.body);
      expect(body.memories).toHaveLength(2);

      const pinned = body.memories.find((m: any) => m.id === id1);
      const unpinned = body.memories.find((m: any) => m.id !== id1);
      expect(pinned.is_pinned).toBe(true);
      expect(unpinned.is_pinned).toBe(false);
    });

    it('should include is_pinned flag in list results', async () => {
      const id1 = await createMemory('mem-1', 'Older Memory');
      await new Promise(resolve => setTimeout(resolve, 50));
      const id2 = await createMemory('mem-2', 'Newer Memory');

      // Pin the older memory
      await pinMemory(id1);

      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${testProjectId}/memories`
      });

      const body = JSON.parse(res.body);
      const pinned = body.memories.find((m: any) => m.id === id1);
      const unpinned = body.memories.find((m: any) => m.id === id2);
      expect(pinned.is_pinned).toBe(true);
      expect(unpinned.is_pinned).toBe(false);
    });

    it('should include is_pinned in compact response', async () => {
      const id1 = await createMemory('mem-1', 'Compact Test');
      await pinMemory(id1);

      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${testProjectId}/memories?compact=true`
      });

      const body = JSON.parse(res.body);
      expect(body.memories[0].is_pinned).toBe(true);
    });
  });

  describe('Cross-project search with pinned filter', () => {
    it('should filter pinned memories in global search', async () => {
      const id1 = await createMemory('mem-1', 'Global First');
      const id2 = await createMemory('mem-2', 'Global Second');
      await pinMemory(id1);

      const res = await app.inject({
        method: 'GET',
        url: `/api/memories?pinned=true&project_id=${testProjectId}`
      });

      const body = JSON.parse(res.body);
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0].id).toBe(id1);
      expect(body.memories[0].is_pinned).toBe(true);
    });

    it('should include is_pinned in global list without filter', async () => {
      const id1 = await createMemory('mem-1', 'Global Pinned');
      await pinMemory(id1);

      const res = await app.inject({
        method: 'GET',
        url: `/api/memories?project_id=${testProjectId}`
      });

      const body = JSON.parse(res.body);
      expect(body.memories.length).toBeGreaterThanOrEqual(1);
      const mem = body.memories.find((m: any) => m.id === id1);
      expect(mem.is_pinned).toBe(true);
    });

    it('should include is_pinned flag in global list', async () => {
      const id1 = await createMemory('mem-1', 'Global Older');
      await new Promise(resolve => setTimeout(resolve, 50));
      const id2 = await createMemory('mem-2', 'Global Newer');

      await pinMemory(id1);

      const res = await app.inject({
        method: 'GET',
        url: `/api/memories?project_id=${testProjectId}`
      });

      const body = JSON.parse(res.body);
      const pinned = body.memories.find((m: any) => m.id === id1);
      const unpinned = body.memories.find((m: any) => m.id === id2);
      expect(pinned.is_pinned).toBe(true);
      expect(unpinned.is_pinned).toBe(false);
    });

    it('should include is_pinned in compact global response', async () => {
      const id1 = await createMemory('mem-1', 'Compact Global');
      await pinMemory(id1);

      const res = await app.inject({
        method: 'GET',
        url: `/api/memories?compact=true&project_id=${testProjectId}`
      });

      const body = JSON.parse(res.body);
      const mem = body.memories.find((m: any) => m.id === id1);
      expect(mem.is_pinned).toBe(true);
    });
  });

  describe('Pinned with PATCH metadata', () => {
    it('should pin via PATCH memory metadata field', async () => {
      const memoryId = await createMemory('mem-patch', 'Patch Pin Test');

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${testProjectId}/memories/${memoryId}`,
        payload: { metadata: { 'is-pinned': 'true' } }
      });

      expect(res.statusCode).toBe(200);

      // Verify it's pinned in list
      const listRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${testProjectId}/memories?pinned=true`
      });

      const body = JSON.parse(listRes.body);
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0].id).toBe(memoryId);
    });
  });

  describe('Single-memory detail endpoints', () => {
    it('should include is_pinned in project-scoped detail', async () => {
      const memoryId = await createMemory('mem-detail', 'Detail Test');
      await pinMemory(memoryId);

      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${testProjectId}/memories/${memoryId}`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.memory.is_pinned).toBe(true);
    });

    it('should return is_pinned false when not pinned (project-scoped)', async () => {
      const memoryId = await createMemory('mem-detail-2', 'Detail Unpinned');

      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${testProjectId}/memories/${memoryId}`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.memory.is_pinned).toBe(false);
    });

    it('should include is_pinned in global detail', async () => {
      const memoryId = await createMemory('mem-global-detail', 'Global Detail Test');
      await pinMemory(memoryId);

      const res = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.memory.is_pinned).toBe(true);
    });

    it('should return is_pinned false when not pinned (global)', async () => {
      const memoryId = await createMemory('mem-global-detail-2', 'Global Detail Unpinned');

      const res = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}`
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.memory.is_pinned).toBe(false);
    });
  });
});
