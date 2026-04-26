import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TEST_DATABASE_URL } from '../setup';

process.env.DATABASE_URL = TEST_DATABASE_URL;

import assistantRoutes from '../../src/routes/assistants';
import assistantSessionRoutes from '../../src/routes/assistant-sessions';
import * as sessionsService from '../../src/services/sessions';

// ── Test fixtures ───────────────────────────────────────────────────

const SAMPLE_SUMMARY_ENTRY = JSON.stringify({
  type: 'summary',
  summary: 'Test Session Summary',
  leafUuid: 'e444d70f-9f90-4a36-b88c-591cfd2ef84f',
});

const SAMPLE_USER_ENTRY = JSON.stringify({
  parentUuid: null,
  isSidechain: false,
  type: 'user',
  message: { role: 'user', content: 'Hello, world!' },
  uuid: '4229ef68-4394-487b-bd4a-0fde2a4c3985',
  timestamp: '2026-01-18T17:12:35.996Z',
  sessionId: '05ad4346-2f6c-4582-bf3f-f6a81d008be2',
});

const SAMPLE_ASSISTANT_ENTRY = JSON.stringify({
  parentUuid: '4229ef68-4394-487b-bd4a-0fde2a4c3985',
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
  uuid: '3ecf8f1c-862f-4712-ad01-51934ec5ff6d',
  timestamp: '2026-01-18T17:12:39.038Z',
  sessionId: '05ad4346-2f6c-4582-bf3f-f6a81d008be2',
});

const SESSION_UUID_1 = '05ad4346-2f6c-4582-bf3f-f6a81d008be2';
const SESSION_UUID_2 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const AGENT_SESSION = 'agent-abc123';

// ── Helpers ─────────────────────────────────────────────────────────

let tmpDir: string;

function createTempSessionStructure() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));

  // Project dir 1: -test-project-alpha
  const proj1Dir = path.join(tmpDir, '-test-project-alpha');
  fs.mkdirSync(proj1Dir, { recursive: true });

  // Session 1: full session with companion dir
  const session1Content = [SAMPLE_SUMMARY_ENTRY, SAMPLE_USER_ENTRY, SAMPLE_ASSISTANT_ENTRY].join('\n');
  fs.writeFileSync(path.join(proj1Dir, `${SESSION_UUID_1}.jsonl`), session1Content);

  // Companion directory with subagents
  const companionDir = path.join(proj1Dir, SESSION_UUID_1);
  fs.mkdirSync(path.join(companionDir, 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(companionDir, 'tool-results'), { recursive: true });
  fs.writeFileSync(path.join(companionDir, 'subagents', 'agent-def456.jsonl'), '{"type":"user"}\n');
  fs.writeFileSync(path.join(companionDir, 'tool-results', 'toolu_01.txt'), 'some tool output');

  // Session 2: simple session without companion
  const session2Content = [SAMPLE_USER_ENTRY, SAMPLE_ASSISTANT_ENTRY].join('\n');
  fs.writeFileSync(path.join(proj1Dir, `${SESSION_UUID_2}.jsonl`), session2Content);

  // Agent session
  fs.writeFileSync(path.join(proj1Dir, `${AGENT_SESSION}.jsonl`), SAMPLE_USER_ENTRY);

  // Project dir 2: -test-project-beta (empty — no jsonl files)
  const proj2Dir = path.join(tmpDir, '-test-project-beta');
  fs.mkdirSync(proj2Dir, { recursive: true });

  // Project dir 3: -test-project-gamma (one old session for bulk delete testing)
  const proj3Dir = path.join(tmpDir, '-test-project-gamma');
  fs.mkdirSync(proj3Dir, { recursive: true });
  fs.writeFileSync(path.join(proj3Dir, `${SESSION_UUID_2}.jsonl`), SAMPLE_USER_ENTRY);
  // Set mtime to 30 days ago
  const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(proj3Dir, `${SESSION_UUID_2}.jsonl`), oldDate, oldDate);

  return tmpDir;
}

function cleanupTempDir() {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Monkey-patch getSessionsBasePath for testing
const originalGetBasePath = sessionsService.getSessionsBasePath;

describe('Session File Management Integration Tests', () => {
  let app: FastifyInstance;
  let client: Client;

  beforeAll(async () => {
    app = Fastify();
    app.register(assistantRoutes, { prefix: '/api/assistants' });
    app.register(assistantSessionRoutes, { prefix: '/api/assistants/:handle/sessions' });

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
    createTempSessionStructure();
  });

  // ── List Projects ───────────────────────────────────────────────

  describe('GET /api/assistants/:handle/sessions — List Session Projects', () => {
    it('should list session project directories with stats', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/assistants/claude-code/sessions`,
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.projects).toBeDefined();
      expect(Array.isArray(body.projects)).toBe(true);
      // Should have 2 projects (alpha has sessions, beta is empty so excluded, gamma has 1)
      expect(body.projects.length).toBe(2);
      expect(body.total_size).toBeGreaterThan(0);
      expect(body.total_sessions).toBeGreaterThanOrEqual(3);

      // Check project shape
      const alpha = body.projects.find((p: any) => p.dir_name === '-test-project-alpha');
      expect(alpha).toBeDefined();
      expect(alpha.session_count).toBe(3); // 2 UUID sessions + 1 agent session
      expect(alpha.total_size).toBeGreaterThan(0);
      expect(alpha.last_modified).toBeDefined();
      expect(alpha.decoded_path).toBe('/test/project/alpha');
    });

    it('should return 404 for unknown assistant', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/assistants/nonexistent/sessions',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('not found');
    });
  });

  // ── Handle Resolution ───────────────────────────────────────────

  describe('Project handle resolution', () => {
    it('should resolve a khef project handle to its session directory', async () => {
      // Create a project with a path that maps to a temp session dir
      const projectPath = '/test/project/alpha';
      const expectedDir = '-test-project-alpha'; // projectPath with / → -
      await client.query(
        `INSERT INTO projects (id, name, handle, display_name, path)
         VALUES (gen_random_uuid(), 'Alpha Project', 'alpha-project', 'Alpha Project', $1)
         ON CONFLICT (handle) DO UPDATE SET path = $1`,
        [projectPath]
      );

      // Use the handle instead of the raw dir name
      const res = await app.inject({
        method: 'GET',
        url: `/api/assistants/claude-code/sessions/alpha-project`,
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.sessions.length).toBe(3); // Same as -test-project-alpha
    });

    it('should fall back to raw dir name when handle is not found', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/assistants/claude-code/sessions/-test-project-alpha`,
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.sessions.length).toBe(3);
    });

    it('should resolve handle in read session endpoint', async () => {
      const projectPath = '/test/project/alpha';
      // Clean up any project with this path from earlier tests
      await client.query('DELETE FROM projects WHERE path = $1', [projectPath]);
      await client.query(
        `INSERT INTO projects (id, name, handle, display_name, path)
         VALUES (gen_random_uuid(), 'Alpha Read', 'alpha-read', 'Alpha Read', $1)
         ON CONFLICT (handle) DO UPDATE SET path = $1`,
        [projectPath]
      );

      const res = await app.inject({
        method: 'GET',
        url: `/api/assistants/claude-code/sessions/alpha-read/${SESSION_UUID_1}`,
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.session.id).toBe(SESSION_UUID_1);
      expect(body.session.entry_count).toBe(3);
    });
  });

  // ── List Sessions ─────────────────────────────────────────────

  describe('GET /api/assistants/:handle/sessions/:projectDir — List Sessions', () => {
    it('should list sessions with metadata and summaries', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/assistants/claude-code/sessions/-test-project-alpha`,
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.sessions).toBeDefined();
      expect(body.sessions.length).toBe(3);
      expect(body.pagination).toBeDefined();
      expect(body.pagination.total_count).toBe(3);

      // Find the session with summary
      const session1 = body.sessions.find((s: any) => s.id === SESSION_UUID_1);
      expect(session1).toBeDefined();
      expect(session1.size).toBeGreaterThan(0);
      expect(session1.has_companion).toBe(true);
      expect(session1.companion_size).toBeGreaterThan(0);
      expect(session1.summary).toBe('Test Session Summary');
      expect(session1.leaf_uuid).toBe('e444d70f-9f90-4a36-b88c-591cfd2ef84f');

      // Session without companion
      const session2 = body.sessions.find((s: any) => s.id === SESSION_UUID_2);
      expect(session2).toBeDefined();
      expect(session2.has_companion).toBe(false);
      expect(session2.companion_size).toBeUndefined();
    });

    it('should support sorting by size', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/assistants/claude-code/sessions/-test-project-alpha`,
        query: { sort: 'size', order: 'desc', _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      // First session should be largest
      for (let i = 1; i < body.sessions.length; i++) {
        expect(body.sessions[i - 1].size).toBeGreaterThanOrEqual(body.sessions[i].size);
      }
    });

    it('should support pagination', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/assistants/claude-code/sessions/-test-project-alpha`,
        query: { limit: '2', offset: '0', _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.sessions.length).toBe(2);
      expect(body.pagination.total_count).toBe(3);
      expect(body.pagination.has_more).toBe(true);
    });

    it('should return empty for non-existent project dir', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/assistants/claude-code/sessions/-nonexistent-project`,
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.sessions).toEqual([]);
      expect(body.pagination.total_count).toBe(0);
    });

    it('should block path traversal attempts', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/assistants/claude-code/sessions/..%2F..%2Fetc`,
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ── Read Session ──────────────────────────────────────────────

  describe('GET /api/assistants/:handle/sessions/:projectDir/:sessionId — Read Session', () => {
    it('should read a session transcript with entries', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/assistants/claude-code/sessions/-test-project-alpha/${SESSION_UUID_1}`,
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.session).toBeDefined();
      expect(body.session.id).toBe(SESSION_UUID_1);
      expect(body.session.size).toBeGreaterThan(0);
      expect(body.session.entry_count).toBe(3);
      expect(body.session.entries.length).toBe(3);

      // Check entry types
      expect(body.session.entries[0].type).toBe('summary');
      expect(body.session.entries[1].type).toBe('user');
      expect(body.session.entries[2].type).toBe('assistant');

      expect(body.pagination.total_count).toBe(3);
      expect(body.pagination.has_more).toBe(false);
    });

    it('should support pagination of entries', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/assistants/claude-code/sessions/-test-project-alpha/${SESSION_UUID_1}`,
        query: { limit: '1', offset: '1', _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.session.entries.length).toBe(1);
      expect(body.session.entries[0].type).toBe('user');
      expect(body.pagination.total_count).toBe(3);
      expect(body.pagination.offset).toBe(1);
      expect(body.pagination.has_more).toBe(true);
    });

    it('should return 404 for non-existent session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/assistants/claude-code/sessions/-test-project-alpha/00000000-0000-0000-0000-000000000000`,
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(404);
    });

    it('should reject invalid session ID format', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/assistants/claude-code/sessions/-test-project-alpha/not-a-valid-id!`,
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should read an agent session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/assistants/claude-code/sessions/-test-project-alpha/${AGENT_SESSION}`,
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.session.id).toBe(AGENT_SESSION);
      expect(body.session.entry_count).toBe(1);
    });
  });

  // ── Delete Session ────────────────────────────────────────────

  describe('DELETE /api/assistants/:handle/sessions/:projectDir/:sessionId — Delete Session', () => {
    it('should delete a session and its companion directory', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/assistants/claude-code/sessions/-test-project-alpha/${SESSION_UUID_1}`,
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(204);

      // Verify file is gone
      const filePath = path.join(tmpDir, '-test-project-alpha', `${SESSION_UUID_1}.jsonl`);
      expect(fs.existsSync(filePath)).toBe(false);

      // Verify companion dir is gone
      const companionPath = path.join(tmpDir, '-test-project-alpha', SESSION_UUID_1);
      expect(fs.existsSync(companionPath)).toBe(false);
    });

    it('should delete a session without companion', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/assistants/claude-code/sessions/-test-project-alpha/${SESSION_UUID_2}`,
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(204);

      const filePath = path.join(tmpDir, '-test-project-alpha', `${SESSION_UUID_2}.jsonl`);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('should return 404 for non-existent session', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/assistants/claude-code/sessions/-test-project-alpha/00000000-0000-0000-0000-000000000000`,
        query: { _basePath: tmpDir },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── Bulk Delete ───────────────────────────────────────────────

  describe('POST /api/assistants/:handle/sessions/bulk-delete — Bulk Delete', () => {
    it('should bulk delete by project directory', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/assistants/claude-code/sessions/bulk-delete`,
        query: { _basePath: tmpDir },
        payload: { projectDir: '-test-project-alpha' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.deleted).toBe(3);
      expect(body.freed_bytes).toBeGreaterThan(0);

      // Verify directory is now empty of jsonl files
      const remaining = fs.readdirSync(path.join(tmpDir, '-test-project-alpha'))
        .filter(f => f.endsWith('.jsonl'));
      expect(remaining.length).toBe(0);
    });

    it('should bulk delete by age (before date)', async () => {
      // Delete sessions older than 7 days
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const res = await app.inject({
        method: 'POST',
        url: `/api/assistants/claude-code/sessions/bulk-delete`,
        query: { _basePath: tmpDir },
        payload: { before: sevenDaysAgo },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      // Only the old session in gamma should be deleted
      expect(body.deleted).toBe(1);
    });

    it('should bulk delete by session IDs', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/assistants/claude-code/sessions/bulk-delete`,
        query: { _basePath: tmpDir },
        payload: {
          projectDir: '-test-project-alpha',
          sessionIds: [SESSION_UUID_1],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.deleted).toBe(1);

      // Other sessions should still exist
      expect(fs.existsSync(path.join(tmpDir, '-test-project-alpha', `${SESSION_UUID_2}.jsonl`))).toBe(true);
    });

    it('should reject when no filter criteria provided', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/assistants/claude-code/sessions/bulk-delete`,
        query: { _basePath: tmpDir },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject invalid date format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/assistants/claude-code/sessions/bulk-delete`,
        query: { _basePath: tmpDir },
        payload: { before: 'not-a-date' },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
