import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import filesystemRoutes from '../../src/routes/filesystem';

describe('GET /api/fs/diff', () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let pathA: string;
  let pathB: string;
  let pathSame: string;

  beforeAll(async () => {
    app = Fastify();
    app.register(filesystemRoutes, { prefix: '/api/fs' });
    await app.ready();

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'khef-fs-diff-'));
    pathA = path.join(tmpDir, 'a.md');
    pathB = path.join(tmpDir, 'b.md');
    pathSame = path.join(tmpDir, 'same.md');

    await fs.writeFile(pathA, 'line one\nline two\nline three\nline four\n');
    await fs.writeFile(pathB, 'line one\nline TWO\nline three\nline four\nline five\n');
    await fs.writeFile(pathSame, 'identical\nidentical\nidentical\n');
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns line-level changes and stats for two different files', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/diff?a=${encodeURIComponent(pathA)}&b=${encodeURIComponent(pathB)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    expect(body.a.path).toBe(pathA);
    expect(body.b.path).toBe(pathB);
    expect(body.a.size).toBeGreaterThan(0);
    expect(body.b.size).toBeGreaterThan(0);
    expect(body.a.modified).toMatch(/T/);
    expect(body.b.modified).toMatch(/T/);

    expect(Array.isArray(body.changes)).toBe(true);
    expect(body.changes.length).toBeGreaterThan(0);

    // The differing "line two" / "line TWO" appears as a remove + add pair,
    // plus the trailing "line five" is an addition.
    expect(body.stats.additions).toBeGreaterThan(0);
    expect(body.stats.deletions).toBeGreaterThan(0);

    // Every change has a known type
    for (const c of body.changes) {
      expect(['add', 'remove', 'equal', 'skip']).toContain(c.type);
    }
  });

  it('reports no additions or deletions when both paths point at identical content', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/diff?a=${encodeURIComponent(pathSame)}&b=${encodeURIComponent(pathSame)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.stats.additions).toBe(0);
    expect(body.stats.deletions).toBe(0);
    expect(body.stats.unchanged).toBeGreaterThan(0);
  });

  it('returns 400 when "a" is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/diff?b=${encodeURIComponent(pathB)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/a.*and.*b/i);
  });

  it('returns 400 when "b" is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/diff?a=${encodeURIComponent(pathA)}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when "context" is not a non-negative integer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/diff?a=${encodeURIComponent(pathA)}&b=${encodeURIComponent(pathB)}&context=-2`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/context/i);
  });

  it('returns 400 when a path is not absolute (relative paths are rejected by validatePath)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/diff?a=relative/path/a.md&b=${encodeURIComponent(pathB)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/invalid path/i);
  });

  it('returns 404 when "a" does not exist', async () => {
    const missing = path.join(tmpDir, 'does-not-exist.md');
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/diff?a=${encodeURIComponent(missing)}&b=${encodeURIComponent(pathB)}`,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toMatch(/not found.*a/i);
  });

  it('returns 400 when one path points at a directory', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/diff?a=${encodeURIComponent(tmpDir)}&b=${encodeURIComponent(pathB)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/not a file/i);
  });

  it('honors the context parameter by collapsing far-from-change equal regions', async () => {
    // Build two files where the only change is at the very top, surrounded by
    // many unchanged lines. With small context, the unchanged tail collapses
    // into a `skip` block.
    const longPathA = path.join(tmpDir, 'long-a.md');
    const longPathB = path.join(tmpDir, 'long-b.md');
    const unchanged = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    await fs.writeFile(longPathA, `start original\n${unchanged}\n`);
    await fs.writeFile(longPathB, `start REVISED\n${unchanged}\n`);

    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/diff?a=${encodeURIComponent(longPathA)}&b=${encodeURIComponent(longPathB)}&context=2`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const hasSkip = body.changes.some((c: { type: string }) => c.type === 'skip');
    expect(hasSkip).toBe(true);
  });
});
