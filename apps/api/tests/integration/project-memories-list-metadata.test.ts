import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { TEST_DATABASE_URL } from '../setup';

// Set env before importing routes so db client uses correct URL
process.env.DATABASE_URL = TEST_DATABASE_URL;

import memoryRoutes from '../../src/routes/memories';
import memoryExportRoutes from '../../src/routes/memory-export';
import projectMemoryRoutes from '../../src/routes/project-memories';
import projectRoutes from '../../src/routes/projects';
import settingsRoutes from '../../src/routes/settings';

describe('Project Memories List — metadata in non-compact response', () => {
  let app: FastifyInstance;
  let client: Client;
  let projectId: string;
  let memWithMetaId: string;
  let memWithoutMetaId: string;
  let memMidId: string;
  let memLastId: string;

  beforeAll(async () => {
    app = Fastify();
    app.register(projectRoutes, { prefix: '/api/projects' });
    app.register(projectMemoryRoutes, { prefix: '/api/projects/:projectId/memories' });
    app.register(memoryRoutes, { prefix: '/api/memories' });
    app.register(memoryExportRoutes, { prefix: '/api/memories' });
    app.register(settingsRoutes, { prefix: '/api/settings' });
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

    const projectRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'List Metadata Test', handle: 'list-metadata-test' },
    });
    projectId = JSON.parse(projectRes.body).project.id;

    // Two memories: one with metadata, one without.
    const m1 = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: { handle: 'mem-with-meta', title: 'Has metadata', content: 'x', type: 'context' },
    });
    memWithMetaId = JSON.parse(m1.body).memory.id;
    await app.inject({
      method: 'PUT',
      url: `/api/memories/${memWithMetaId}/metadata/slide-order`,
      payload: { value: '5' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/memories/${memWithMetaId}/metadata/svg-max-width`,
      payload: { value: '1250' },
    });

    const m2 = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: { handle: 'mem-without-meta', title: 'No metadata', content: 'y', type: 'context' },
    });
    memWithoutMetaId = JSON.parse(m2.body).memory.id;

    // Two more memories with slide-order so the slide-order ordering is non-trivial.
    const m3 = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: { handle: 'mem-mid', title: 'Mid', content: 'z', type: 'context' },
    });
    memMidId = JSON.parse(m3.body).memory.id;
    await app.inject({
      method: 'PUT',
      url: `/api/memories/${memMidId}/metadata/slide-order`,
      payload: { value: '15' },
    });

    const m4 = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: { handle: 'mem-last', title: 'Last', content: 'w', type: 'context' },
    });
    memLastId = JSON.parse(m4.body).memory.id;
    await app.inject({
      method: 'PUT',
      url: `/api/memories/${memLastId}/metadata/slide-order`,
      payload: { value: '30' },
    });
  });

  it('returns metadata as a Record<string,string> on each memory in non-compact mode', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/memories?compact=false&limit=200`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const byId = new Map<string, any>(body.memories.map((m: any) => [m.id, m]));

    const withMeta = byId.get(memWithMetaId);
    expect(withMeta).toBeDefined();
    expect(withMeta.metadata).toEqual({ 'slide-order': '5', 'svg-max-width': '1250' });

    const lastMeta = byId.get(memLastId);
    expect(lastMeta.metadata).toEqual({ 'slide-order': '30' });
  });

  it('omits the metadata field entirely when a memory has no metadata rows', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/memories?compact=false&limit=200`,
    });
    const body = JSON.parse(res.body);
    const without = body.memories.find((m: any) => m.id === memWithoutMetaId);
    expect(without).toBeDefined();
    expect(without).not.toHaveProperty('metadata');
  });

  it('does not include metadata in compact mode (compact response shape unchanged)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/memories?compact=true&limit=200`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    for (const m of body.memories) {
      expect(m).not.toHaveProperty('metadata');
    }
  });

  it('matches the single-memory endpoint metadata shape exactly', async () => {
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/memories?compact=false&limit=200`,
    });
    const fromList = JSON.parse(listRes.body).memories.find(
      (m: any) => m.id === memWithMetaId,
    );

    const singleRes = await app.inject({
      method: 'GET',
      url: `/api/memories/${memWithMetaId}`,
    });
    const fromSingle = JSON.parse(singleRes.body).memory ?? JSON.parse(singleRes.body);

    expect(fromList.metadata).toEqual(fromSingle.metadata);
  });

  it('preserves metadata so a client can sort by slide-order numerically', async () => {
    // Reproduces the bug where the UI's slide_order sort fell back to API
    // insertion order because metadata was missing from list responses.
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/memories?compact=false&limit=200`,
    });
    const body = JSON.parse(res.body);

    const withSlideOrder = body.memories
      .map((m: any) => ({
        id: m.id,
        slideOrder: Number((m.metadata ?? {})['slide-order']),
      }))
      .filter((m: any) => Number.isFinite(m.slideOrder))
      .sort((a: any, b: any) => a.slideOrder - b.slideOrder);

    expect(withSlideOrder.map((m: any) => m.id)).toEqual([
      memWithMetaId, // 5
      memMidId,      // 15
      memLastId,     // 30
    ]);
  });
});
