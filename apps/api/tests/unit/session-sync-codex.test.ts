import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { matchProject, parseCodexSession, readCodexSessionMeta } from '../../src/services/session-sync';

const TEMP_DIRS: string[] = [];

function writeJsonl(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-sync-'));
  TEMP_DIRS.push(dir);
  const filePath = path.join(
    dir,
    'rollout-2026-05-01T20-26-22-00000000-0000-0000-0000-000000000000.jsonl'
  );
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
  return filePath;
}

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Codex session sync parsing', () => {
  it('parses modern response_item Codex JSONL records', async () => {
    const filePath = writeJsonl([
      {
        timestamp: '2026-05-02T01:27:37.903Z',
        type: 'session_meta',
        payload: {
          id: '019de64b-39f2-7e21-a056-33aa5c87c322',
          timestamp: '2026-05-02T01:26:22.968Z',
          cwd: '/Users/roger/projects/khef-labs/khef',
          originator: 'codex-tui',
          cli_version: '0.125.0',
        },
      },
      {
        timestamp: '2026-05-02T01:27:38.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'do not index developer setup' }],
        },
      },
      {
        timestamp: '2026-05-02T01:27:39.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Please inspect Codex sync.' }],
        },
      },
      {
        timestamp: '2026-05-02T01:27:40.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I will inspect the session file.' }],
        },
      },
      {
        timestamp: '2026-05-02T01:27:41.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call_exec',
          arguments: '{"cmd":"rg codex"}',
        },
      },
      {
        timestamp: '2026-05-02T01:27:42.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'check_live_messages',
          call_id: 'call_messages',
          arguments: '{"session_id":"019de64b-39f2-7e21-a056-33aa5c87c322"}',
        },
      },
      {
        timestamp: '2026-05-02T01:27:43.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_exec',
          output: 'large shell output should not be chunked',
        },
      },
      {
        timestamp: '2026-05-02T01:27:44.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_messages',
          output: 'live inbox content',
        },
      },
      {
        timestamp: '2026-05-02T01:27:45.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 400,
              output_tokens: 75,
              reasoning_output_tokens: 20,
              total_tokens: 1075,
            },
            last_token_usage: {
              input_tokens: 250,
              cached_input_tokens: 100,
              output_tokens: 50,
              reasoning_output_tokens: 10,
              total_tokens: 300,
            },
            model_context_window: 258400,
          },
        },
      },
    ]);

    const parsed = await parseCodexSession(filePath);

    expect(parsed.sessionId).toBe('019de64b-39f2-7e21-a056-33aa5c87c322');
    expect(parsed.name).toBe('rollout');
    expect(parsed.projectPath).toBe('/Users/roger/projects/khef-labs/khef');
    expect(parsed.startedAt?.toISOString()).toBe('2026-05-02T01:26:22.968Z');
    expect(parsed.endedAt?.toISOString()).toBe('2026-05-02T01:27:45.000Z');
    expect(parsed.messages.map((m) => m.content)).toEqual([
      'Please inspect Codex sync.',
      'I will inspect the session file.',
      '[Tool: exec_command] {"cmd":"rg codex"}',
      '[Tool: check_live_messages] {"session_id":"019de64b-39f2-7e21-a056-33aa5c87c322"}',
      '[Tool Result: check_live_messages] live inbox content',
    ]);
    expect(parsed.usage.totalInputTokens).toBe(1000);
    expect(parsed.usage.totalCacheReadTokens).toBe(400);
    expect(parsed.usage.totalOutputTokens).toBe(75);
    expect(parsed.usage.contextWindowTokens).toBe(250);
  });

  it('matches Codex sessions to projects using session cwd', () => {
    const projectMap = new Map<string, string>([
      ['/Users/roger/projects/khef-labs/khef'.replace(/\//g, '-'), 'project-id'],
    ]);

    expect(
      matchProject(
        '/Users/roger/.codex/sessions/2026/05/01/rollout-2026.jsonl',
        projectMap,
        '/Users/roger/projects/khef-labs/khef'
      )
    ).toBe('project-id');
  });
});

describe('readCodexSessionMeta', () => {
  it('returns sessionId, cwd, and startedAt from session_meta without parsing the whole file', async () => {
    const filePath = writeJsonl([
      {
        timestamp: '2026-05-02T01:27:37.903Z',
        type: 'session_meta',
        payload: {
          id: '019de64b-39f2-7e21-a056-33aa5c87c322',
          timestamp: '2026-05-02T01:26:22.968Z',
          cwd: '/Users/roger/projects/khef-labs/khef',
        },
      },
      // Trailing transcript content the reader should skip past.
      {
        timestamp: '2026-05-02T01:27:39.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'should not affect metadata' }],
        },
      },
    ]);

    const meta = await readCodexSessionMeta(filePath);

    expect(meta).not.toBeNull();
    expect(meta!.sessionId).toBe('019de64b-39f2-7e21-a056-33aa5c87c322');
    expect(meta!.cwd).toBe('/Users/roger/projects/khef-labs/khef');
    expect(meta!.startedAt?.toISOString()).toBe('2026-05-02T01:26:22.968Z');
    expect(meta!.filePath).toBe(filePath);
    expect(meta!.mtime).toBeInstanceOf(Date);
  });

  it('returns null when no session_meta is present in the head window', async () => {
    const filePath = writeJsonl([
      { timestamp: '2026-05-02T01:27:39.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
    ]);

    expect(await readCodexSessionMeta(filePath, { maxLines: 5 })).toBeNull();
  });

  it('skips malformed JSON lines while scanning for session_meta', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-meta-malformed-'));
    TEMP_DIRS.push(dir);
    const filePath = path.join(dir, 'rollout-2026-05-01T20-26-22-019de64b-39f2-7e21-a056-33aa5c87c322.jsonl');
    const lines = [
      'not-json-at-all',
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: '019de64b-39f2-7e21-a056-33aa5c87c322',
          cwd: '/Users/roger/projects/khef-labs/khef',
          timestamp: '2026-05-02T01:26:22.968Z',
        },
      }),
    ];
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

    const meta = await readCodexSessionMeta(filePath);
    expect(meta?.sessionId).toBe('019de64b-39f2-7e21-a056-33aa5c87c322');
  });
});
