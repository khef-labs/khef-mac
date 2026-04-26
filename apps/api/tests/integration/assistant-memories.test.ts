import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TEST_DATABASE_URL } from '../setup';

process.env.DATABASE_URL = TEST_DATABASE_URL;

import assistantRoutes from '../../src/routes/assistants';
import assistantMemoryRoutes from '../../src/routes/assistant-memories';

// ── Helpers ─────────────────────────────────────────────────────────

let tmpDir: string;

function createTempMemoryStructure() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));

  // Project 1: -test-project-alpha (has memory files)
  const proj1MemDir = path.join(tmpDir, '-test-project-alpha', 'memory');
  fs.mkdirSync(proj1MemDir, { recursive: true });
  fs.writeFileSync(path.join(proj1MemDir, 'MEMORY.md'), '# Main Memory\n\nSome content here.');
  fs.writeFileSync(path.join(proj1MemDir, 'notes.md'), '# Notes\n\nSome notes.');

  // Project 2: -test-project-beta (no memory dir)
  fs.mkdirSync(path.join(tmpDir, '-test-project-beta'), { recursive: true });

  // Project 3: -test-project-gamma (memory dir but no .md files)
  const proj3MemDir = path.join(tmpDir, '-test-project-gamma', 'memory');
  fs.mkdirSync(proj3MemDir, { recursive: true });
  fs.writeFileSync(path.join(proj3MemDir, 'readme.txt'), 'not a markdown file');

  return tmpDir;
}

function cleanupTempDir() {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('Assistant Memory Files Integration Tests', () => {
  let app: FastifyInstance;
  let client: Client;

  beforeAll(async () => {
    app = Fastify();
    app.register(assistantRoutes, { prefix: '/api/assistants' });
    app.register(assistantMemoryRoutes, { prefix: '/api/assistants/:handle/memories' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    cleanupTempDir();
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    cleanupTempDir();
    createTempMemoryStructure();

    // Clean up any DB records from previous tests
    await client.query('DELETE FROM assistant_memory_file_snapshots');
    await client.query('DELETE FROM assistant_memory_files');
  });

  // ── List Projects ───────────────────────────────────────────────

  describe('GET /api/assistants/:handle/memories — List Memory Projects', () => {
    it('should list projects with memory directories', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories',
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.projects).toBeDefined();
      expect(Array.isArray(body.projects)).toBe(true);
      // Only alpha has .md files in memory/
      expect(body.projects.length).toBe(1);
      expect(body.projects[0].dir_name).toBe('-test-project-alpha');
      expect(body.projects[0].file_count).toBe(2);
      expect(body.projects[0].total_size).toBeGreaterThan(0);
      expect(body.projects[0].decoded_path).toBe('/test/project/alpha');
    });

    it('should return 404 for unknown assistant', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/assistants/nonexistent/memories',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('not found');
    });
  });

  // ── List Files ────────────────────────────────────────────────

  describe('GET /api/assistants/:handle/memories/:projectDir — List Memory Files', () => {
    it('should list memory files with metadata', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha',
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.files).toBeDefined();
      expect(body.files.length).toBe(2);

      // MEMORY.md should be first (is_main sorting)
      const mainFile = body.files[0];
      expect(mainFile.filename).toBe('MEMORY.md');
      expect(mainFile.is_main).toBe(true);
      expect(mainFile.has_file).toBe(true);
      expect(mainFile.current_snapshot).toBe(1);
      expect(mainFile.snapshot_count).toBe(1);

      const notesFile = body.files[1];
      expect(notesFile.filename).toBe('notes.md');
      expect(notesFile.is_main).toBe(false);
    });

    it('should return empty array for project with no memory files', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-gamma',
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.files).toEqual([]);
    });

    it('should reject path traversal in projectDir', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/..%2F..%2Fetc',
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ── Read File ────────────────────────────────────────────────

  describe('GET /api/assistants/:handle/memories/:projectDir/:filename — Read Memory File', () => {
    it('should read current version content', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/MEMORY.md',
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.file).toBeDefined();
      expect(body.file.filename).toBe('MEMORY.md');
      expect(body.file.content).toBe('# Main Memory\n\nSome content here.');
      expect(body.file.is_main).toBe(true);
      expect(body.file.current_snapshot).toBe(1);
    });

    it('should return 404 for nonexistent file', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/nonexistent.md',
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(404);
    });

    it('should reject filename without .md extension', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/config.txt',
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject path traversal in filename', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/..%2F..%2Fpasswd.md',
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ── Write File ────────────────────────────────────────────────

  describe('PUT /api/assistants/:handle/memories/:projectDir/:filename — Write Memory File', () => {
    it('should create new file with version 1', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/new-file.md',
        query: { _basePath: tmpDir },
        payload: { content: '# New File\n\nCreated via API.' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.file.filename).toBe('new-file.md');
      expect(body.file.content).toBe('# New File\n\nCreated via API.');
      expect(body.file.current_snapshot).toBe(1);

      // Verify file exists on disk
      const filePath = path.join(tmpDir, '-test-project-alpha', 'memory', 'new-file.md');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('# New File\n\nCreated via API.');
    });

    it('should create new version when content changes', async () => {
      // First, discover the existing file
      await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/MEMORY.md',
        query: { _basePath: tmpDir },
      });

      // Write changed content
      const res = await app.inject({
        method: 'PUT',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/MEMORY.md',
        query: { _basePath: tmpDir },
        payload: { content: '# Main Memory\n\nUpdated content.' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.file.current_snapshot).toBe(2);
      expect(body.file.content).toBe('# Main Memory\n\nUpdated content.');
    });

    it('should not create new version when content is unchanged', async () => {
      // Discover existing file
      await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/MEMORY.md',
        query: { _basePath: tmpDir },
      });

      // Write same content
      const res = await app.inject({
        method: 'PUT',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/MEMORY.md',
        query: { _basePath: tmpDir },
        payload: { content: '# Main Memory\n\nSome content here.' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.file.current_snapshot).toBe(1);
      expect(body.file.snapshot_count).toBe(1);
    });

    it('should return 400 when content is missing', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/test.md',
        query: { _basePath: tmpDir },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('should create memory directory if it does not exist', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/assistants/claude-code/memories/-test-project-beta/MEMORY.md',
        query: { _basePath: tmpDir },
        payload: { content: '# Beta Memory' },
      });

      expect(res.statusCode).toBe(200);
      const filePath = path.join(tmpDir, '-test-project-beta', 'memory', 'MEMORY.md');
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  // ── Version Pruning ──────────────────────────────────────────

  describe('Snapshot pruning (max 5 snapshots)', () => {
    it('should prune old snapshots beyond 5', async () => {
      // Create 6 versions by writing different content
      for (let i = 1; i <= 6; i++) {
        await app.inject({
          method: 'PUT',
          url: '/api/assistants/claude-code/memories/-test-project-alpha/pruning-test.md',
          query: { _basePath: tmpDir },
          payload: { content: `Version ${i} content` },
        });
      }

      // Check versions
      const res = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/pruning-test.md/snapshots',
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.snapshots.length).toBe(5);
      // Should have versions 2-6 (version 1 pruned)
      const versionNumbers = body.snapshots.map((v: any) => v.snapshot_number).sort((a: number, b: number) => a - b);
      expect(versionNumbers).toEqual([2, 3, 4, 5, 6]);
    });
  });

  // ── Version Listing and Retrieval ────────────────────────────

  describe('GET .../snapshots — List versions', () => {
    it('should list all versions ordered by version desc', async () => {
      // Create file and update it
      await app.inject({
        method: 'PUT',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/versioned.md',
        query: { _basePath: tmpDir },
        payload: { content: 'v1 content' },
      });
      await app.inject({
        method: 'PUT',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/versioned.md',
        query: { _basePath: tmpDir },
        payload: { content: 'v2 content' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/versioned.md/snapshots',
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.snapshots.length).toBe(2);
      expect(body.snapshots[0].snapshot_number).toBe(2);
      expect(body.snapshots[1].snapshot_number).toBe(1);
    });

    it('should return 404 for nonexistent file', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/nonexistent.md/snapshots',
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET .../snapshots/:snapshot — Get specific snapshot', () => {
    it('should return specific version content', async () => {
      await app.inject({
        method: 'PUT',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/versioned2.md',
        query: { _basePath: tmpDir },
        payload: { content: 'first version' },
      });
      await app.inject({
        method: 'PUT',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/versioned2.md',
        query: { _basePath: tmpDir },
        payload: { content: 'second version' },
      });

      // Get version 1
      const res1 = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/versioned2.md/snapshots/1',
        query: { _basePath: tmpDir },
      });
      expect(res1.statusCode).toBe(200);
      const body1 = JSON.parse(res1.payload);
      expect(body1.snapshot.content).toBe('first version');

      // Get version 2
      const res2 = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/versioned2.md/snapshots/2',
        query: { _basePath: tmpDir },
      });
      expect(res2.statusCode).toBe(200);
      const body2 = JSON.parse(res2.payload);
      expect(body2.snapshot.content).toBe('second version');
    });

    it('should return 404 for nonexistent version', async () => {
      await app.inject({
        method: 'PUT',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/ver-test.md',
        query: { _basePath: tmpDir },
        payload: { content: 'hello' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/ver-test.md/snapshots/99',
        query: { _basePath: tmpDir },
      });
      expect(res.statusCode).toBe(404);
    });

    it('should return 400 for invalid version number', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/MEMORY.md/snapshots/abc',
        query: { _basePath: tmpDir },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── Delete Version ────────────────────────────────────────────

  describe('DELETE .../snapshots/:snapshot — Delete a snapshot', () => {
    it('should delete a version when multiple exist', async () => {
      await app.inject({
        method: 'PUT',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/del-ver.md',
        query: { _basePath: tmpDir },
        payload: { content: 'v1' },
      });
      await app.inject({
        method: 'PUT',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/del-ver.md',
        query: { _basePath: tmpDir },
        payload: { content: 'v2' },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/del-ver.md/snapshots/1',
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(204);

      // Verify only version 2 remains
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/del-ver.md/snapshots',
        query: { _basePath: tmpDir },
      });
      const body = JSON.parse(listRes.payload);
      expect(body.snapshots.length).toBe(1);
      expect(body.snapshots[0].snapshot_number).toBe(2);
    });

    it('should block deleting the only remaining version', async () => {
      await app.inject({
        method: 'PUT',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/single-ver.md',
        query: { _basePath: tmpDir },
        payload: { content: 'only version' },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/single-ver.md/snapshots/1',
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('only remaining');
    });
  });

  // ── Delete File ───────────────────────────────────────────────

  describe('DELETE /api/assistants/:handle/memories/:projectDir/:filename — Delete File', () => {
    it('should delete file from disk and mark as deleted in DB', async () => {
      // First discover the file
      await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/MEMORY.md',
        query: { _basePath: tmpDir },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/MEMORY.md',
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);

      // Verify file is gone from disk
      const filePath = path.join(tmpDir, '-test-project-alpha', 'memory', 'MEMORY.md');
      expect(fs.existsSync(filePath)).toBe(false);

      // Verify DB record still exists but file_path is null
      const dbRes = await client.query(
        `SELECT file_path FROM assistant_memory_files WHERE filename = 'MEMORY.md' AND project_dir = '-test-project-alpha'`
      );
      expect(dbRes.rows.length).toBe(1);
      expect(dbRes.rows[0].file_path).toBeNull();
    });

    it('should return 404 for unknown file', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/nonexistent.md',
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── Project Handle Resolution ─────────────────────────────────

  describe('Project handle resolution', () => {
    it('should resolve a khef project handle to memory dir', async () => {
      // Create a project with path matching our temp dir
      const projectPath = '/test/project/alpha';
      await client.query(
        `INSERT INTO projects (id, name, handle, display_name, path)
         VALUES (gen_random_uuid(), 'Alpha Project', 'alpha-project', 'Alpha Project', $1)
         ON CONFLICT (handle) DO UPDATE SET path = $1`,
        [projectPath]
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/alpha-project',
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.files.length).toBe(2);
    });
  });

  // ── Discovery: deleted file detection ─────────────────────────

  describe('Discovery: deleted file detection', () => {
    it('should mark file as deleted when removed from disk', async () => {
      // First discover the file
      await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha/notes.md',
        query: { _basePath: tmpDir },
      });

      // Delete file from disk manually
      fs.unlinkSync(path.join(tmpDir, '-test-project-alpha', 'memory', 'notes.md'));

      // List again - discovery should mark it as deleted
      const res = await app.inject({
        method: 'GET',
        url: '/api/assistants/claude-code/memories/-test-project-alpha',
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      // notes.md should still appear but has_file = false
      const notesFile = body.files.find((f: any) => f.filename === 'notes.md');
      expect(notesFile).toBeDefined();
      expect(notesFile.has_file).toBe(false);
    });
  });
});
