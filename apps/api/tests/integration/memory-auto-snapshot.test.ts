import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { setupTestDb, TEST_DATABASE_URL } from '../setup';

process.env.DATABASE_URL = TEST_DATABASE_URL;

import projectRoutes from '../../src/routes/projects';
import projectMemoryRoutes from '../../src/routes/project-memories';
import memorySnapshotRoutes from '../../src/routes/memory-snapshots';
import memorySectionsRoutes from '../../src/routes/memory-sections';

describe('Memory auto-snapshot on content-changing routes', () => {
  let app: FastifyInstance;
  let client: Client;
  let projectId: string;

  beforeAll(async () => {
    await setupTestDb();

    app = Fastify();
    app.register(projectRoutes, { prefix: '/api/projects' });
    app.register(projectMemoryRoutes, { prefix: '/api/projects/:projectId/memories' });
    app.register(memorySnapshotRoutes, { prefix: '/api/memories/:memoryId/snapshots' });
    app.register(memorySectionsRoutes, { prefix: '/api/memories' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE projects CASCADE');

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Auto-snapshot test', description: 'test' },
    });
    projectId = JSON.parse(res.payload).project.id;
  });

  async function createMemory(content: string, handle = 'auto-snap'): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: {
        handle,
        title: `Auto snap ${handle}`,
        content,
        type: 'user-note',
      },
    });
    return JSON.parse(res.payload).memory.id;
  }

  async function listSnapshots(memoryId: string) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/${memoryId}/snapshots`,
    });
    return JSON.parse(res.payload);
  }

  describe('PATCH /api/projects/:projectId/memories/:memoryId', () => {
    it('saves a pre-update snapshot when content changes', async () => {
      const memoryId = await createMemory('original content');

      const before = await listSnapshots(memoryId);
      expect(before.snapshots).toHaveLength(0);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/memories/${memoryId}`,
        payload: { content: 'updated content' },
      });
      expect(res.statusCode).toBe(200);

      const after = await listSnapshots(memoryId);
      expect(after.snapshots).toHaveLength(1);
      expect(after.snapshots[0].source).toBe('pre-update');
      // Snapshot captures the OLD content
      const snap = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/snapshots/${after.snapshots[0].snapshot_number}`,
      });
      expect(JSON.parse(snap.payload).content).toBe('original content');
    });

    it('does not snapshot when only metadata changes (no content field)', async () => {
      const memoryId = await createMemory('x');

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/memories/${memoryId}`,
        payload: { title: 'New title only' },
      });
      expect(res.statusCode).toBe(200);

      const after = await listSnapshots(memoryId);
      expect(after.snapshots).toHaveLength(0);
    });

    it('does not snapshot when only tags change', async () => {
      const memoryId = await createMemory('x');

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/memories/${memoryId}`,
        payload: { tags: ['t1', 't2'] },
      });
      expect(res.statusCode).toBe(200);

      const after = await listSnapshots(memoryId);
      expect(after.snapshots).toHaveLength(0);
    });

    it('does not snapshot when content is set but unchanged', async () => {
      const memoryId = await createMemory('same content');

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/memories/${memoryId}`,
        payload: { content: 'same content' },
      });
      expect(res.statusCode).toBe(200);

      const after = await listSnapshots(memoryId);
      expect(after.snapshots).toHaveLength(0);
    });

    it('uses manual source (not pre-update) when ?snapshot=true is passed', async () => {
      const memoryId = await createMemory('v1');

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/memories/${memoryId}?snapshot=true`,
        payload: { content: 'v2' },
      });
      expect(res.statusCode).toBe(200);

      const after = await listSnapshots(memoryId);
      // Only one snapshot — the manual one — not duplicated as pre-update
      expect(after.snapshots).toHaveLength(1);
      expect(after.snapshots[0].source).toBe('manual');
    });
  });

  describe('POST /api/projects/:projectId/memories/:memoryId/append', () => {
    it('saves a pre-update snapshot before appending', async () => {
      const memoryId = await createMemory('start');

      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories/${memoryId}/append`,
        payload: { content: 'more', separator: ' ' },
      });
      expect(res.statusCode).toBe(200);

      const after = await listSnapshots(memoryId);
      expect(after.snapshots).toHaveLength(1);
      expect(after.snapshots[0].source).toBe('pre-update');

      const snap = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/snapshots/${after.snapshots[0].snapshot_number}`,
      });
      expect(JSON.parse(snap.payload).content).toBe('start');
    });
  });

  describe('PATCH /api/memories/:memoryId/sections/:heading', () => {
    it('saves a pre-update snapshot before a section edit', async () => {
      const memoryId = await createMemory('# Title\n\nIntro paragraph.\n\n## Sub\n\nSub content.');

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/sections/Sub`,
        payload: { content: 'New sub content.' },
      });
      expect(res.statusCode).toBe(200);

      const after = await listSnapshots(memoryId);
      expect(after.snapshots).toHaveLength(1);
      expect(after.snapshots[0].source).toBe('pre-update');

      const snap = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/snapshots/${after.snapshots[0].snapshot_number}`,
      });
      expect(JSON.parse(snap.payload).content).toContain('Sub content.');
    });

    it('does not snapshot when the section update is rejected by the collision guard', async () => {
      const memoryId = await createMemory(
        '# Title\n\n## Parent\n\nIntro.\n\n### A\n\naa\n\n### B\n\nbb'
      );

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/sections/Parent`,
        payload: { content: 'rewrite\n\n### A\n\nxxx' },
      });
      expect(res.statusCode).toBe(400);

      const after = await listSnapshots(memoryId);
      expect(after.snapshots).toHaveLength(0);
    });
  });
});
