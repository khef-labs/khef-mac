import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Client } from 'pg';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TEST_DATABASE_URL } from '../setup';

process.env.DATABASE_URL = TEST_DATABASE_URL;

import {
  heartbeatSession,
  registerCodexSessionFile,
  getActiveSessionBySessionId,
} from '../../src/services/active-sessions';

const TEMP_DIRS: string[] = [];

function writeCodexJsonl(payload: { id: string; cwd: string; timestamp?: string }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-register-'));
  TEMP_DIRS.push(dir);
  const filePath = path.join(
    dir,
    `rollout-2026-05-01T20-26-22-${payload.id}.jsonl`
  );
  const sessionMeta = {
    timestamp: '2026-05-02T01:27:37.903Z',
    type: 'session_meta',
    payload: {
      id: payload.id,
      cwd: payload.cwd,
      timestamp: payload.timestamp ?? '2026-05-02T01:26:22.968Z',
    },
  };
  const userMessage = {
    timestamp: '2026-05-02T01:27:39.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'register me as active' }],
    },
  };
  fs.writeFileSync(filePath, [JSON.stringify(sessionMeta), JSON.stringify(userMessage)].join('\n'), 'utf8');
  return filePath;
}

describe('Codex session registration', () => {
  let client: Client;
  let projectId: string;
  const projectPath = `/Users/roger/projects/khef-labs/khef-codex-register-${Date.now()}`;

  beforeAll(async () => {
    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();

    // Create a project whose path matches the cwd we'll embed in session_meta
    // so registerCodexSessionFile can resolve project_id from the encoded cwd.
    const handle = `codex-test-${Date.now()}`;
    const projRow = await client.query<{ id: string }>(
      `INSERT INTO projects (name, handle, display_name, path) VALUES ($1, $2, $3, $4) RETURNING id`,
      ['Codex Register Test', handle, 'Codex Register Test', projectPath]
    );
    projectId = projRow.rows[0].id;
  });

  afterAll(async () => {
    await client.query('DELETE FROM session_chunks WHERE session_id IN (SELECT id FROM sessions WHERE project_id = $1)', [projectId]);
    await client.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
    await client.query('DELETE FROM projects WHERE id = $1', [projectId]);
    await client.end();
  });

  beforeEach(async () => {
    await client.query(
      `DELETE FROM session_chunks WHERE session_id IN (SELECT id FROM sessions WHERE project_id = $1)`,
      [projectId]
    );
    await client.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
  });

  afterEach(() => {
    for (const dir of TEMP_DIRS.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('registers a Codex session under the codex-cli assistant using the real session UUID', async () => {
    const sessionId = '019de64b-39f2-7e21-a056-33aa5c87c322';
    const filePath = writeCodexJsonl({ id: sessionId, cwd: projectPath });

    const result = await registerCodexSessionFile(filePath, { pid: 99999, syncTranscript: false });

    expect(result.session_id).toBe(sessionId);
    expect(result.cwd).toBe(projectPath);
    expect(result.project_id).toBe(projectId);
    expect(result.nickname).toBeTruthy();

    const row = await getActiveSessionBySessionId(sessionId);
    expect(row).not.toBeNull();
    expect(row!.assistant_handle).toBe('codex-cli');
    expect(row!.session_id).toBe(sessionId);
    expect(row!.project_id).toBe(projectId);
    expect(row!.status).toBe('active');
    expect(row!.pid).toBe(99999);
    // project_dir is the cwd encoded with slash → dash, matching loadProjectMap()
    expect(row!.project_dir).toBe(projectPath.replace(/\//g, '-'));
  });

  it('preserves an existing nickname on re-registration', async () => {
    const sessionId = '019de64b-39f2-7e21-a056-aaaaaaaaaaaa';
    const filePath = writeCodexJsonl({ id: sessionId, cwd: projectPath });

    const first = await registerCodexSessionFile(filePath, { syncTranscript: false });
    const nickname = first.nickname;
    expect(nickname).toBeTruthy();

    const second = await registerCodexSessionFile(filePath, { syncTranscript: false });
    expect(second.nickname).toBe(nickname);
  });

  it('throws when session_meta is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-no-meta-'));
    TEMP_DIRS.push(dir);
    const filePath = path.join(dir, 'rollout-2026-05-01T20-26-22-019de64b-39f2-7e21-a056-bbbbbbbbbbbb.jsonl');
    fs.writeFileSync(filePath, JSON.stringify({ type: 'response_item', payload: {} }), 'utf8');

    await expect(registerCodexSessionFile(filePath, { syncTranscript: false })).rejects.toThrow(/session_meta/);
  });

  it('legacy heartbeat without opts still registers under claude-code', async () => {
    // Regression: heartbeatSession(sessionId, filePath) with no opts must keep
    // its historical Claude-only behavior so the existing UserPromptSubmit
    // hook payload continues to work.
    const sessionId = '019de64b-39f2-7e21-a056-cccccccccccc';
    const homeProjectsDir = path.join(os.homedir(), '.claude', 'projects', '-some-claude-project');
    const fakeFilePath = path.join(homeProjectsDir, `${sessionId}.jsonl`);

    await heartbeatSession(sessionId, fakeFilePath);

    const row = await getActiveSessionBySessionId(sessionId);
    expect(row).not.toBeNull();
    expect(row!.assistant_handle).toBe('claude-code');
    expect(row!.project_dir).toBe('-some-claude-project');

    // Cleanup since this row isn't tied to projectId
    await client.query('DELETE FROM sessions WHERE session_id = $1', [sessionId]);
  });
});
