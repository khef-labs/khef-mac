import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { setupTestDb, TEST_DATABASE_URL } from '../setup';

process.env.DATABASE_URL = TEST_DATABASE_URL;

import projectRoutes from '../../src/routes/projects';
import projectMemoryRoutes from '../../src/routes/project-memories';
import memorySnapshotRoutes from '../../src/routes/memory-snapshots';

describe('Memory Snapshot Diff', () => {
  let app: FastifyInstance;
  let client: Client;
  let projectId: string;

  beforeAll(async () => {
    await setupTestDb();

    app = Fastify();
    app.register(projectRoutes, { prefix: '/api/projects' });
    app.register(projectMemoryRoutes, { prefix: '/api/projects/:projectId/memories' });
    app.register(memorySnapshotRoutes, { prefix: '/api/memories/:memoryId/snapshots' });

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
      payload: { name: 'Snapshot Diff Test', description: 'test' },
    });
    projectId = JSON.parse(res.payload).project.id;
  });

  /** Helper: create a memory and return its id */
  async function createMemory(content: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: {
        handle: 'diff-test-memory',
        title: 'Diff test memory',
        content,
        type: 'user-note',
      },
    });
    return JSON.parse(res.payload).memory.id;
  }

  /** Helper: update memory with snapshot */
  async function updateWithSnapshot(memoryId: string, content: string) {
    await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/memories/${memoryId}?snapshot=true`,
      payload: { content },
    });
  }

  it('should diff two historical snapshots', async () => {
    const memoryId = await createMemory('line 1\nline 2\nline 3\n');

    // Edit with snapshot twice
    await updateWithSnapshot(memoryId, 'line 1\nline 2 changed\nline 3\n');
    await updateWithSnapshot(memoryId, 'line 1\nline 2 changed\nline 3\nline 4\n');

    // Snapshot 1 = original, snapshot 2 = first edit
    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/${memoryId}/snapshots/diff?from=1&to=2`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    expect(body.memory_id).toBe(memoryId);
    expect(body.from.snapshot_number).toBe(1);
    expect(body.to.snapshot_number).toBe(2);
    expect(body.changes).toBeDefined();
    expect(body.stats).toBeDefined();
    expect(body.stats.additions).toBeGreaterThanOrEqual(0);
    expect(body.stats.deletions).toBeGreaterThanOrEqual(0);
    expect(body.stats.unchanged).toBeGreaterThanOrEqual(0);

    // There should be changes since content differs
    const hasChanges = body.changes.some(
      (c: { type: string }) => c.type === 'add' || c.type === 'remove'
    );
    expect(hasChanges).toBe(true);
  });

  it('should diff with "current" alias', async () => {
    const memoryId = await createMemory('original content\n');
    await updateWithSnapshot(memoryId, 'updated content\n');

    // Diff snapshot 1 (original) vs current
    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/${memoryId}/snapshots/diff?from=1&to=current`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    expect(body.from.snapshot_number).toBe(1);
    expect(body.to.source).toBe('current');
    expect(body.changes.length).toBeGreaterThan(0);
  });

  it('should return empty diff for identical content', async () => {
    const memoryId = await createMemory('same content\n');

    // Diff current with itself
    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/${memoryId}/snapshots/diff?from=current&to=current`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    expect(body.stats.additions).toBe(0);
    expect(body.stats.deletions).toBe(0);
    // With default context, equal content may be collapsed to skip
    expect(body.changes.every((c: { type: string }) => c.type === 'equal' || c.type === 'skip')).toBe(true);
  });

  it('should return 400 when missing params', async () => {
    const memoryId = await createMemory('content');

    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/${memoryId}/snapshots/diff`,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toContain('required');
  });

  it('should return 400 for invalid snapshot reference', async () => {
    const memoryId = await createMemory('content');

    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/${memoryId}/snapshots/diff?from=abc&to=1`,
    });

    expect(res.statusCode).toBe(400);
  });

  it('should return 404 for non-existent snapshot', async () => {
    const memoryId = await createMemory('content');

    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/${memoryId}/snapshots/diff?from=99&to=current`,
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toContain('99');
  });

  it('should apply context parameter to trim equal chunks', async () => {
    // Create memory with many lines
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const memoryId = await createMemory(lines);

    // Change one line in the middle
    const editedLines = lines.replace('line 25', 'line 25 CHANGED');
    await updateWithSnapshot(memoryId, editedLines);

    // Diff with context=3
    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/${memoryId}/snapshots/diff?from=1&to=current&context=3`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    // Should have skip chunks where unchanged lines were trimmed
    const skipChunks = body.changes.filter((c: { type: string }) => c.type === 'skip');
    expect(skipChunks.length).toBeGreaterThan(0);

    // Each skip chunk should have lines_skipped
    for (const skip of skipChunks) {
      expect(skip.lines_skipped).toBeGreaterThan(0);
      expect(skip.value).toBe('');
    }

    // Stats should still reflect full diff (context doesn't change stats)
    expect(body.stats.unchanged).toBeGreaterThan(0);
  });

  it('should apply default context=3 when param is omitted', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const memoryId = await createMemory(lines);
    await updateWithSnapshot(memoryId, lines.replace('line 10', 'line 10 CHANGED'));

    // Without context param — default context=3 applies, so skip chunks expected
    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/${memoryId}/snapshots/diff?from=1&to=current`,
    });

    const body = JSON.parse(res.payload);
    const skipChunks = body.changes.filter((c: { type: string }) => c.type === 'skip');
    expect(skipChunks.length).toBeGreaterThan(0);
  });

  it('should return 400 for invalid context value', async () => {
    const memoryId = await createMemory('content');

    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/${memoryId}/snapshots/diff?from=current&to=current&context=abc`,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toContain('context');
  });

  it('should return 404 for non-existent memory', async () => {
    const fakeId = '019c0000-0000-7000-8000-000000000000';

    const res = await app.inject({
      method: 'GET',
      url: `/api/memories/${fakeId}/snapshots/diff?from=1&to=current`,
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toContain('Memory not found');
  });
});
