import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TEST_DATABASE_URL } from '../setup';

process.env.DATABASE_URL = TEST_DATABASE_URL;

import sessionSearchRoutes from '../../src/routes/session-search';

// ── Fixture builders ────────────────────────────────────────────────

const JIRA_ACCOUNT_ID = '712020:abcd1234-ef56-7890-fedc-ba9876543210';

function userLine(content: string, ts = '2026-01-15T10:00:00Z', uuid = 'u-1') {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    uuid,
    timestamp: ts,
  });
}

function assistantTextLine(text: string, ts = '2026-01-15T10:01:00Z', uuid = 'a-1') {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    uuid,
    timestamp: ts,
  });
}

function toolUseLine(toolName: string, input: Record<string, unknown>, ts = '2026-01-15T10:02:00Z') {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu-1', name: toolName, input },
      ],
    },
    uuid: 'a-tool',
    timestamp: ts,
  });
}

function toolResultLine(content: string, ts = '2026-01-15T10:02:30Z') {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu-1', content },
      ],
    },
    uuid: 'u-tool-result',
    timestamp: ts,
  });
}

// ── Test setup ──────────────────────────────────────────────────────

let app: FastifyInstance;
let client: Client;
let tmpDir: string;
let sessionFilePath: string;
const SESSION_UUID = 'aaaa1111-bbbb-2222-cccc-333344445555';

beforeAll(async () => {
  app = Fastify();
  app.register(sessionSearchRoutes, { prefix: '/api/sessions' });
  await app.ready();

  client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  await client.end();
  await app.close();
});

beforeEach(async () => {
  await client.query('TRUNCATE sessions CASCADE');

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-grep-test-'));
  sessionFilePath = path.join(tmpDir, `${SESSION_UUID}.jsonl`);
  const content = [
    userLine('What is my Jira account?'),
    assistantTextLine('Let me check.'),
    toolUseLine('mcp__atlassian__jira_get_user', { email: 'roger@example.com' }),
    toolResultLine(JSON.stringify({ accountId: JIRA_ACCOUNT_ID, displayName: 'Roger' })),
    assistantTextLine(`Your account id is ${JIRA_ACCOUNT_ID}`, '2026-01-15T10:03:00Z', 'a-final'),
  ].join('\n');
  fs.writeFileSync(sessionFilePath, content);

  // Register the session so session_id scope resolves to this file.
  const assistantRow = await client.query<{ id: string }>(
    `SELECT id FROM assistants WHERE handle = 'claude-code' LIMIT 1`
  );
  await client.query(
    `INSERT INTO sessions (session_id, assistant_id, file_path, file_size, message_count, nickname)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [SESSION_UUID, assistantRow.rows[0].id, sessionFilePath, fs.statSync(sessionFilePath).size, 5, 'griptest']
  );
});

// ── Tests ───────────────────────────────────────────────────────────

describe('POST /api/sessions/grep', () => {
  it('requires a pattern', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/grep',
      payload: { session_id: SESSION_UUID },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/pattern/);
  });

  it('requires at least one scope filter', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/grep',
      payload: { pattern: 'anything' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/scope/i);
  });

  it('finds a literal Jira account id inside a tool_result block', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/grep',
      payload: { pattern: JIRA_ACCOUNT_ID, session_id: SESSION_UUID },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.matches.length).toBeGreaterThanOrEqual(2); // tool_result + final assistant line
    const toolResultHit = body.matches.find((m: any) => m.excerpt.includes('tool_result'));
    expect(toolResultHit).toBeDefined();
    expect(toolResultHit.role).toBe('user');
    expect(toolResultHit.excerpt).toContain(JIRA_ACCOUNT_ID);
    expect(body.text).toContain('Found');
    expect(body.text).toContain(JIRA_ACCOUNT_ID);
  });

  it('returns zero matches cleanly when nothing matches', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/grep',
      payload: { pattern: 'xyznoexist999', session_id: SESSION_UUID },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.matches).toHaveLength(0);
    expect(body.text).toMatch(/No matches/);
  });

  it('resolves scope by nickname across lineage', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/grep',
      payload: { pattern: 'Jira account', nickname: 'griptest' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.files_scanned).toBe(1);
    expect(body.scope).toContain('nickname=griptest');
    expect(body.matches.length).toBeGreaterThan(0);
  });

  it('supports case-insensitive match by default', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/grep',
      payload: { pattern: 'JIRA ACCOUNT', session_id: SESSION_UUID },
    });
    const body = JSON.parse(res.payload);
    expect(body.matches.length).toBeGreaterThan(0);
  });

  it('respects case_sensitive=true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/grep',
      payload: { pattern: 'JIRA ACCOUNT', session_id: SESSION_UUID, case_sensitive: true },
    });
    const body = JSON.parse(res.payload);
    expect(body.matches).toHaveLength(0);
  });

  it('supports regex mode', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/grep',
      payload: { pattern: 'account[Ii]d', session_id: SESSION_UUID, is_regex: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.matches.length).toBeGreaterThan(0);
  });

  it('returns 404 when session_id has no on-disk file', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/grep',
      payload: { pattern: 'x', session_id: '99999999-0000-0000-0000-000000000000' },
    });
    expect(res.statusCode).toBe(404);
  });
});
