import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestDb, TEST_DATABASE_URL } from '../setup';

// Set env before importing routes so db client uses correct URL
process.env.DATABASE_URL = TEST_DATABASE_URL;

import memoryExportRoutes from '../../src/routes/memory-export';
import projectRoutes from '../../src/routes/projects';
import projectMemoryRoutes from '../../src/routes/project-memories';

describe('Memory Export Routes', () => {
  let app: FastifyInstance;
  let client: Client;
  let projectId: string;
  let memoryId: string;

  beforeAll(async () => {
    await setupTestDb();

    app = Fastify();
    app.register(projectRoutes, { prefix: '/api/projects' });
    app.register(projectMemoryRoutes, { prefix: '/api/projects/:projectId/memories' });
    app.register(memoryExportRoutes, { prefix: '/api/memories' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE projects CASCADE');

    // Create a project
    const projectRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Export Test Project', description: 'For testing exports' },
    });
    const project = JSON.parse(projectRes.payload).project;
    projectId = project.id;

    // Create a memory with markdown content and tags
    const memoryRes = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: {
        handle: 'test-export-memory',
        title: 'Test Export Memory',
        content:
          '# Overview\n\nThis is a **bold** statement.\n\n- Item one\n- Item two\n\n| Column A | Column B |\n| --- | --- |\n| Alpha | Beta |\n| Gamma | Delta |\n\n```js\nconsole.log(\"hello\")\nconsole.log(\"world\")\n```\n\nRegular paragraph here.',
        type: 'decision',
        tags: ['architecture', 'testing'],
      },
    });
    const memory = JSON.parse(memoryRes.payload).memory;
    memoryId = memory.id;
  });

  describe('GET /api/memories/:memoryId/export', () => {
    it('returns 400 when format is missing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/export`,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('format');
    });

    it('returns 400 when format is invalid', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/export?format=pdf`,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('format');
    });

    it('returns 400 for invalid UUID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memories/not-a-uuid/export?format=markdown',
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('UUID');
    });

    it('returns 404 for non-existent memory', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memories/00000000-0000-0000-0000-000000000000/export?format=markdown',
      });
      expect(res.statusCode).toBe(404);
    });

    describe('format=markdown', () => {
      it('returns markdown with correct content-type and disposition', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/memories/${memoryId}/export?format=markdown`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/markdown');
        expect(res.headers['content-disposition']).toMatch(/test-export-memory.*\.md/);
      });

      it('returns content without metadata', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/memories/${memoryId}/export?format=markdown`,
        });
        const body = res.payload;

        // Should contain content directly, no frontmatter
        expect(body.startsWith('---')).toBe(false);
        expect(body).not.toContain('title:');
        expect(body).toContain('# Overview');
        expect(body).toContain('**bold**');
      });
    });

    describe('format=slack', () => {
      it('returns slack mrkdwn with text/plain content-type', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/memories/${memoryId}/export?format=slack`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/plain');
        // No content-disposition for clipboard content
        expect(res.headers['content-disposition']).toBeUndefined();
      });

      it('converts headings to bold', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/memories/${memoryId}/export?format=slack`,
        });
        const body = res.payload;
        expect(body).toContain('*Overview*');
        // Original markdown heading should be gone
        expect(body).not.toContain('# Overview');
      });

      it('converts bullets to unicode bullets', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/memories/${memoryId}/export?format=slack`,
        });
        const body = res.payload;
        expect(body).toContain('• Item one');
        expect(body).toContain('• Item two');
      });

      it('converts bold syntax', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/memories/${memoryId}/export?format=slack`,
        });
        const body = res.payload;
        // **bold** should become *bold* (Slack single asterisk bold)
        expect(body).toContain('*bold*');
        expect(body).not.toContain('**bold**');
      });

      it('does not include metadata header', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/memories/${memoryId}/export?format=slack`,
        });
        const body = res.payload;
        // No metadata header — just converted content
        expect(body).not.toContain('decision');
        expect(body).not.toContain('Export Test Project');
      });
    });

    describe('format=docx', () => {
      it('returns docx with correct content-type and disposition', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/memories/${memoryId}/export?format=docx`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain(
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        );
        expect(res.headers['content-disposition']).toMatch(/test-export-memory.*\.docx/);
      });

      it('returns valid binary (starts with PK ZIP header)', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/memories/${memoryId}/export?format=docx`,
        });
        // DOCX is a ZIP file — first two bytes are 'PK' (0x50 0x4B)
        const buffer = Buffer.from(res.rawPayload);
        expect(buffer[0]).toBe(0x50); // P
        expect(buffer[1]).toBe(0x4b); // K
      });

      it('produces non-trivial output', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/memories/${memoryId}/export?format=docx`,
        });
        const buffer = Buffer.from(res.rawPayload);
        // A DOCX with content should be at least a few KB
        expect(buffer.length).toBeGreaterThan(1000);
      });
    });
  });

  describe('POST /api/memories/:memoryId/save-to-drive', () => {
    let driveDir: string;

    beforeEach(async () => {
      driveDir = await mkdtemp(join(tmpdir(), 'khef-drive-'));
    });

    afterEach(async () => {
      await rm(driveDir, { recursive: true, force: true });
    });

    it('returns 400 when drive.syncFolder is not configured', async () => {
      // Ensure no setting exists
      await client.query("DELETE FROM settings WHERE key = 'drive.syncFolder'");

      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/save-to-drive`,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('drive.syncFolder not configured');
    });

    it('returns error when drive folder cannot be created', async () => {
      await client.query(
        "INSERT INTO settings (key, value) VALUES ('drive.syncFolder', '/nonexistent/path') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/save-to-drive`,
      });
      // Route now attempts mkdir -p; /nonexistent/path fails with permissions error
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('returns 404 for non-existent memory', async () => {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('drive.syncFolder', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [driveDir]
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/memories/00000000-0000-0000-0000-000000000000/save-to-drive',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for invalid UUID', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memories/not-a-uuid/save-to-drive',
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('UUID');
    });

    it('defaults to markdown format', async () => {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('drive.syncFolder', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [driveDir]
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/save-to-drive`,
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.payload);
      expect(body.filename).toMatch(/^test-export-memory.*\.md$/);
      expect(body.path).toMatch(/test-export-memory.*\.md$/);

      const files = await readdir(driveDir);
      const mdFile = files.find((f: string) => f.startsWith('test-export-memory') && f.endsWith('.md'));
      expect(mdFile).toBeDefined();
      const content = await readFile(join(driveDir, mdFile!), 'utf-8');
      expect(content).toContain('Overview');
    });

    it('saves docx file when format=docx', async () => {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('drive.syncFolder', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [driveDir]
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/save-to-drive?format=docx`,
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.payload);
      expect(body.filename).toMatch(/^test-export-memory.*\.docx$/);
      expect(body.path).toMatch(/test-export-memory.*\.docx$/);

      const files = await readdir(driveDir);
      const docxFile = files.find((f: string) => f.startsWith('test-export-memory') && f.endsWith('.docx'));
      expect(docxFile).toBeDefined();
      const content = await readFile(join(driveDir, docxFile!));
      expect(content[0]).toBe(0x50); // P
      expect(content[1]).toBe(0x4b); // K
    });

    it('returns 400 for invalid format', async () => {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('drive.syncFolder', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [driveDir]
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/save-to-drive?format=pdf`,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('Invalid format');
    });

    it('saves to subfolder when provided', async () => {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('drive.syncFolder', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [driveDir]
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/save-to-drive?subfolder=my-project`,
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.payload);
      expect(body.path).toMatch(/my-project\/test-export-memory.*\.md$/);

      const subFiles = await readdir(join(driveDir, 'my-project'));
      const mdFile = subFiles.find((f: string) => f.startsWith('test-export-memory') && f.endsWith('.md'));
      expect(mdFile).toBeDefined();
    });

    it('overwrites existing file (idempotent)', async () => {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('drive.syncFolder', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [driveDir]
      );

      // Save twice
      await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/save-to-drive`,
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/save-to-drive`,
      });
      expect(res.statusCode).toBe(200);

      const files = await readdir(driveDir);
      expect(files.filter((f: string) => f.endsWith('.md'))).toHaveLength(1);
    });

    it('rejects path traversal in subfolder', async () => {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('drive.syncFolder', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [driveDir]
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/memories/${memoryId}/save-to-drive?subfolder=../../etc`,
      });
      // Path traversal dots are stripped, so it should still work but land in a safe path
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.path).not.toContain('..');
    });
  });
});
