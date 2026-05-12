/**
 * Assistant chat service.
 *
 * Dispatches chat prompts to Claude, Codex, or Gemini backends.
 * Simplified versions of the kdag-executor spawn functions (no job tracking).
 */

import { spawn } from 'child_process';
import { workerLogger } from '../lib/logger';
import { generateContent, type ResponsePart, type UrlContextFetched } from './gemini';
import { checkBackendAvailability } from './kdag-executor';

const log = workerLogger.child({ component: 'assistant-chat' });

/** Timeout per subprocess (3 minutes — more generous for interactive chat). */
const CHAT_TIMEOUT_MS = 3 * 60 * 1000;

/** Per-backend concurrency limits. CLI backends spawn subprocesses so they're tighter. */
const CONCURRENCY_LIMITS: Record<string, number> = {
  claude: 3,
  codex: 3,
  gemini: 5,
};

/** Active call counters per backend. */
const activeCalls: Record<string, number> = { claude: 0, codex: 0, gemini: 0 };

/** Check if a backend has capacity. */
export function hasCapacity(handle: string): boolean {
  const backend = resolveBackend(handle);
  return activeCalls[backend] < (CONCURRENCY_LIMITS[backend] ?? 3);
}

/** Get current concurrency info for a backend. */
export function getConcurrencyInfo(handle: string): { active: number; limit: number } {
  const backend = resolveBackend(handle);
  return { active: activeCalls[backend], limit: CONCURRENCY_LIMITS[backend] ?? 3 };
}

/**
 * Sliding window rate limiter.
 * Tracks request timestamps per key and rejects when window limit is exceeded.
 */
const RATE_WINDOW_MS = 60_000;          // 1 minute window
const RATE_LIMIT_PER_WINDOW = 30;       // Max requests per window (global)
const requestTimestamps: number[] = [];

/** Check if a new request is within the rate limit. Prunes stale entries. */
export function checkRateLimit(): { allowed: boolean; remaining: number; resetMs: number } {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;

  // Prune timestamps outside the window
  while (requestTimestamps.length > 0 && requestTimestamps[0] <= windowStart) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= RATE_LIMIT_PER_WINDOW) {
    const resetMs = requestTimestamps[0] + RATE_WINDOW_MS - now;
    return { allowed: false, remaining: 0, resetMs };
  }

  requestTimestamps.push(now);
  return { allowed: true, remaining: RATE_LIMIT_PER_WINDOW - requestTimestamps.length, resetMs: 0 };
}

/** Get rate limit info without consuming a slot. */
export function getRateLimitInfo(): { current: number; limit: number; windowMs: number } {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  while (requestTimestamps.length > 0 && requestTimestamps[0] <= windowStart) {
    requestTimestamps.shift();
  }
  return { current: requestTimestamps.length, limit: RATE_LIMIT_PER_WINDOW, windowMs: RATE_WINDOW_MS };
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GroundingData {
  searchQueries: string[];
  sources: Array<{ uri: string; title: string }>;
}

export interface ThinkingData {
  text: string;
  tokenCount: number;
}

export interface UrlContextData {
  fetched: UrlContextFetched[];
}

export interface ChatResult {
  response: string;
  responseParts?: ResponsePart[];
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  error: string | null;
  session_id?: string;
  grounding?: GroundingData | null;
  thinking?: ThinkingData | null;
  urlContext?: UrlContextData | null;
}

/**
 * Format conversation history into XML-tagged prompt for CLI backends.
 */
export function formatConversationHistory(messages: ChatMessage[], currentPrompt: string): string {
  if (!messages || messages.length === 0) {
    return currentPrompt;
  }

  const historyLines = messages.map(
    m => `<message role="${m.role}">${m.content}</message>`
  );

  return `<conversation>\n${historyLines.join('\n')}\n</conversation>\n\n<prompt>${currentPrompt}</prompt>`;
}

/**
 * Resolve assistant handle to backend key.
 */
function resolveBackend(handle: string): 'claude' | 'codex' | 'gemini' {
  if (handle === 'gemini') return 'gemini';
  if (handle === 'codex-cli') return 'codex';
  return 'claude';
}

/**
 * Check if a specific backend is available. Returns reason if unavailable.
 */
export async function checkAvailability(handle: string): Promise<{ available: boolean; reason?: string }> {
  const backends = await checkBackendAvailability();
  const backend = backends.find(b => b.key === handle);
  if (!backend) {
    return { available: false, reason: `Unknown assistant handle: ${handle}` };
  }
  return { available: backend.available, reason: backend.reason };
}

/**
 * Run `claude -p` and return output.
 *
 * When sessionId is provided, uses `--resume` for multi-turn continuity
 * (sessions persist to disk so `--resume` can find them).
 * When allowedTools is provided, passes `--allowedTools` and optionally
 * `--permission-mode` to grant tool access without interactive prompts.
 */
function runClaude(args: {
  promptText: string;
  model?: string;
  timeoutMs?: number;
  sessionId?: string;
  resumeSession?: boolean;
  systemPrompt?: string;
  allowedTools?: string[];
  permissionMode?: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const hasSession = !!args.sessionId;
    const hasTools = args.allowedTools && args.allowedTools.length > 0;

    const cliArgs = [
      '-p', args.promptText,
      '--output-format', 'text',
    ];

    // When using sessions or tools, we need settings and persistence.
    // Otherwise, use lightweight mode with no settings/persistence.
    if (!hasSession && !hasTools) {
      cliArgs.push('--setting-sources', '', '--no-session-persistence');
    }

    if (args.model) {
      cliArgs.push('--model', args.model);
    }

    if (args.sessionId) {
      // --resume for existing sessions, --session-id for new ones
      cliArgs.push(args.resumeSession ? '--resume' : '--session-id', args.sessionId);
    }

    if (args.systemPrompt) {
      cliArgs.push('--system-prompt', args.systemPrompt);
    }

    if (hasTools) {
      cliArgs.push('--allowedTools', args.allowedTools!.join(','));
    }

    if (args.permissionMode) {
      cliArgs.push('--permission-mode', args.permissionMode);
    }

    log.info({
      model: args.model,
      promptLen: args.promptText.length,
      sessionId: args.sessionId,
      hasTools,
    }, 'Chat: spawning claude -p');

    const child = spawn('claude', cliArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let resolved = false;

    const timeoutMs = args.timeoutMs ?? CHAT_TIMEOUT_MS;

    const safeResolve = (result: { stdout: string; stderr: string; exitCode: number }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      log.warn({ timeoutMs }, 'Chat: claude -p timed out');
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
      setTimeout(() => {
        safeResolve({ stdout, stderr: `Process timed out after ${timeoutMs}ms`, exitCode: 124 });
      }, 10000);
    }, timeoutMs);

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (timedOut) {
        safeResolve({ stdout, stderr: `Process timed out after ${timeoutMs}ms`, exitCode: 124 });
      } else {
        safeResolve({ stdout, stderr, exitCode: code ?? 1 });
      }
    });

    child.on('error', (err) => {
      stderr += err.message;
      safeResolve({ stdout, stderr, exitCode: 1 });
    });

    child.stdin.end();
  });
}

/**
 * Run `codex exec` and return output.
 *
 * When sessionId is provided and resumeSession is true, uses `codex exec resume`
 * for multi-turn continuity (sessions persist to disk so resume can find them).
 */
function runCodex(args: {
  promptText: string;
  model?: string;
  timeoutMs?: number;
  sessionId?: string;
  resumeSession?: boolean;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const { tmpdir } = require('os');
    const { join } = require('path');
    const { randomUUID } = require('crypto');
    const fs = require('fs');

    const outFile = join(tmpdir(), `codex-chat-${randomUUID()}.txt`);
    const isResume = args.resumeSession && args.sessionId;

    const cliArgs: string[] = isResume
      ? [
          'exec', 'resume',
          args.sessionId!,
          '-o', outFile,
        ]
      : [
          'exec',
          '-c', 'instructions=""',
          '-C', '/tmp',
          '--skip-git-repo-check',
          '-o', outFile,
        ];
    if (args.model) {
      cliArgs.push('-m', args.model);
    }
    cliArgs.push(args.promptText);

    log.info({ model: args.model, promptLen: args.promptText.length }, 'Chat: spawning codex exec');

    const child = spawn('codex', cliArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stderr = '';
    let timedOut = false;
    let resolved = false;

    const timeoutMs = args.timeoutMs ?? CHAT_TIMEOUT_MS;

    const safeResolve = (result: { stdout: string; stderr: string; exitCode: number }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      log.warn({ timeoutMs }, 'Chat: codex exec timed out');
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
      setTimeout(() => {
        let stdout = '';
        try { stdout = fs.readFileSync(outFile, 'utf-8'); fs.unlinkSync(outFile); } catch {}
        safeResolve({ stdout, stderr: `Process timed out after ${timeoutMs}ms`, exitCode: 124 });
      }, 10000);
    }, timeoutMs);

    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('close', (code) => {
      let stdout = '';
      try { stdout = fs.readFileSync(outFile, 'utf-8'); fs.unlinkSync(outFile); } catch {}

      if (timedOut) {
        safeResolve({ stdout, stderr: `Process timed out after ${timeoutMs}ms`, exitCode: 124 });
      } else {
        safeResolve({ stdout, stderr, exitCode: code ?? 1 });
      }
    });

    child.on('error', (err) => {
      stderr += err.message;
      safeResolve({ stdout: '', stderr, exitCode: 1 });
    });

    child.stdin.end();
  });
}

/**
 * Chat with an assistant backend.
 * Dispatches to Claude, Codex, or Gemini based on the handle.
 */
export async function chatWithAssistant(args: {
  handle: string;
  promptText: string;
  messages?: ChatMessage[];
  model?: string;
  sessionId?: string;
  resumeSession?: boolean;
  systemPrompt?: string;
  allowedTools?: string[];
  permissionMode?: string;
  useGoogleSearch?: boolean;
  useUrlContext?: boolean;
  useThinking?: boolean;
  thinkingBudget?: number;
}): Promise<ChatResult> {
  const backend = resolveBackend(args.handle);

  activeCalls[backend]++;
  log.info({ backend, active: activeCalls[backend], limit: CONCURRENCY_LIMITS[backend] }, 'Chat: acquired slot');

  try {
    return await dispatchToBackend(backend, args);
  } finally {
    activeCalls[backend]--;
    log.info({ backend, active: activeCalls[backend] }, 'Chat: released slot');
  }
}

async function dispatchToBackend(
  backend: 'claude' | 'codex' | 'gemini',
  args: {
    promptText: string;
    messages?: ChatMessage[];
    model?: string;
    sessionId?: string;
    resumeSession?: boolean;
    systemPrompt?: string;
    allowedTools?: string[];
    permissionMode?: string;
    useGoogleSearch?: boolean;
    useUrlContext?: boolean;
    useThinking?: boolean;
    thinkingBudget?: number;
  },
): Promise<ChatResult> {
  if (backend === 'gemini') {
    return chatWithGemini(args.promptText, args.messages, args.model, {
      useGoogleSearch: args.useGoogleSearch,
      useUrlContext: args.useUrlContext,
      useThinking: args.useThinking,
      thinkingBudget: args.thinkingBudget,
      systemPrompt: args.systemPrompt,
    });
  }

  // CLI backends: format history into prompt
  // When using Claude sessions, history is managed by the session — skip formatting
  const fullPrompt = args.sessionId
    ? args.promptText
    : formatConversationHistory(args.messages || [], args.promptText);

  if (backend === 'codex') {
    const result = await runCodex({
      promptText: args.sessionId ? args.promptText : fullPrompt,
      model: args.model,
      sessionId: args.sessionId,
      resumeSession: args.resumeSession,
    });
    if (result.exitCode !== 0) {
      return {
        response: '',
        model: args.model || 'default',
        input_tokens: null,
        output_tokens: null,
        error: result.stderr || `codex exited with code ${result.exitCode}`,
      };
    }
    return {
      response: result.stdout.trim(),
      model: args.model || 'default',
      input_tokens: null,
      output_tokens: null,
      error: null,
    };
  }

  // Default: Claude
  const result = await runClaude({
    promptText: fullPrompt,
    model: args.model,
    sessionId: args.sessionId,
    resumeSession: args.resumeSession,
    systemPrompt: args.systemPrompt,
    allowedTools: args.allowedTools,
    permissionMode: args.permissionMode,
  });
  if (result.exitCode !== 0) {
    return {
      response: '',
      model: args.model || 'default',
      input_tokens: null,
      output_tokens: null,
      error: result.stderr || `claude exited with code ${result.exitCode}`,
    };
  }
  return {
    response: result.stdout.trim(),
    model: args.model || 'default',
    input_tokens: null,
    output_tokens: null,
    error: null,
    session_id: args.sessionId,
  };
}

/**
 * Chat with Gemini using native multi-turn `contents` array.
 */
async function chatWithGemini(
  promptText: string,
  messages?: ChatMessage[],
  model?: string,
  options?: {
    useGoogleSearch?: boolean;
    useUrlContext?: boolean;
    useThinking?: boolean;
    thinkingBudget?: number;
    systemPrompt?: string;
  },
): Promise<ChatResult> {
  // Build Gemini contents array from history + current prompt
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

  if (messages) {
    for (const msg of messages) {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }
  }

  // Append current prompt
  contents.push({
    role: 'user',
    parts: [{ text: promptText }],
  });

  try {
    const result = await generateContent(promptText, {
      model: model || undefined,
      contents,
      useGoogleSearch: options?.useGoogleSearch,
      useUrlContext: options?.useUrlContext,
      useThinking: options?.useThinking,
      thinkingBudget: options?.thinkingBudget,
      systemPrompt: options?.systemPrompt,
    });

    return {
      response: result.response,
      responseParts: result.responseParts,
      model: result.model,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      error: null,
      grounding: result.grounding || null,
      thinking: result.thinking || null,
      urlContext: result.urlContext || null,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      response: '',
      model: model || 'default',
      input_tokens: null,
      output_tokens: null,
      error,
    };
  }
}
