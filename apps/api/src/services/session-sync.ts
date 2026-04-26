/**
 * Session sync service.
 * Parses session transcripts and stores in PostgreSQL for full-text search.
 * Supports both Claude Code and Codex CLI session formats.
 */

import { workerLogger } from '../lib/logger';
import * as fs from 'fs';

const log = workerLogger.child({ component: 'session-sync' });
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import pool, { query, querySingle } from '../db/client';

const CHUNK_TARGET_SIZE = 2000; // Target characters per chunk
const CHUNK_MIN_SIZE = 500;    // Don't create tiny trailing chunks
const BATCH_SIZE = 20;         // Max sessions to process per sync cycle

// Tools whose results we want preserved in session chunks (most results are stripped for size).
const WHITELISTED_TOOL_RESULTS = new Set<string>([
  'mcp__khef__check_live_messages',
  'check_live_messages',
]);

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text as string)
      .join('\n');
  }
  return '';
}

// Base paths for each assistant's sessions
export const SESSION_PATHS: Record<string, { basePath: string; structure: 'project' | 'date' }> = {
  'claude-code': {
    basePath: path.join(os.homedir(), '.claude', 'projects'),
    structure: 'project', // <project-dir>/<session-id>.jsonl
  },
  'codex-cli': {
    basePath: path.join(os.homedir(), '.codex', 'sessions'),
    structure: 'date', // <year>/<month>/<day>/<name>-<timestamp>-<session-id>.jsonl
  },
};

export interface SessionSyncResult {
  synced: number;
  updated: number;
  skipped: number;
  errors: number;
  chunks_created: number;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: Date;
}

interface UsageStats {
  model: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  contextWindowTokens: number; // last turn's context fill (input + cache_creation + cache_read)
}

interface ParsedSession {
  sessionId: string;
  name?: string;
  summary?: string;
  messages: ParsedMessage[];
  startedAt?: Date;
  endedAt?: Date;
  fileSize: number;
  filePath: string;
  usage: UsageStats;
}

interface SessionChunk {
  chunkIndex: number;
  content: string;
  messageCount: number;
}

// ── Parsing ─────────────────────────────────────────────────────────

/**
 * Extract session ID from filename.
 * Claude: <session-id>.jsonl
 * Codex: <name>-<timestamp>-<session-id>.jsonl
 */
function extractSessionId(filename: string, structure: 'project' | 'date'): { sessionId: string; name?: string } {
  const basename = filename.replace('.jsonl', '');

  if (structure === 'project') {
    return { sessionId: basename };
  }

  // Codex format: name-2026-01-31T17-49-39-019c1676-537c-79c2-b145-9cfef6b46c2d
  // The session ID is the UUID at the end
  const uuidMatch = basename.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/);
  if (uuidMatch) {
    const sessionId = uuidMatch[1];
    // Extract name (everything before the timestamp)
    const prefix = basename.slice(0, basename.indexOf(sessionId) - 1);
    // Remove timestamp portion (last part with T and dashes)
    const timestampMatch = prefix.match(/-\d{4}-\d{2}-\d{2}T[\d-]+$/);
    const name = timestampMatch ? prefix.slice(0, prefix.length - timestampMatch[0].length) : prefix;
    return { sessionId, name: name || undefined };
  }

  return { sessionId: basename };
}

/**
 * Parse a Claude Code session file.
 */
async function parseClaudeSession(filePath: string): Promise<ParsedSession> {
  const stat = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const messages: ParsedMessage[] = [];
  let summary: string | undefined;
  let startedAt: Date | undefined;
  let endedAt: Date | undefined;
  const modelCounts = new Map<string, number>();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let lastContextWindowTokens = 0;
  // Track tool_use id -> tool name across the whole session so we can look up
  // the originating tool when a tool_result block appears on a later user message.
  const toolUseIdToName = new Map<string, string>();

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line);

      // Track timestamps
      if (entry.timestamp) {
        const ts = new Date(entry.timestamp);
        if (!startedAt || ts < startedAt) startedAt = ts;
        if (!endedAt || ts > endedAt) endedAt = ts;
      }

      // Capture summary
      if (entry.type === 'summary' && entry.summary) {
        summary = entry.summary;
        continue;
      }

      // Skip non-conversation entries
      if (!['user', 'assistant'].includes(entry.type)) continue;

      const message = entry.message;
      if (!message?.content) continue;

      // Track usage from assistant messages
      if (entry.type === 'assistant' && message.usage) {
        const u = message.usage;
        totalInputTokens += (u.input_tokens || 0);
        totalOutputTokens += (u.output_tokens || 0);
        totalCacheCreationTokens += (u.cache_creation_input_tokens || 0);
        totalCacheReadTokens += (u.cache_read_input_tokens || 0);
        // Track last turn's context fill (sum of all input token types)
        lastContextWindowTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      }
      if (entry.type === 'assistant' && message.model) {
        modelCounts.set(message.model, (modelCounts.get(message.model) || 0) + 1);
      }

      let content = '';

      // Handle string content (common for user messages)
      if (typeof message.content === 'string') {
        content = message.content;
      }
      // Handle array content (common for assistant messages)
      else if (Array.isArray(message.content)) {
        const textParts: string[] = [];
        const seenTools = new Set<string>();
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          }
          // Include thinking for assistant messages
          if (block.type === 'thinking' && block.thinking && entry.type === 'assistant') {
            textParts.push(`[Thinking] ${block.thinking}`);
          }
          // Include tool usage (deduplicated within message)
          if (block.type === 'tool_use' && block.name) {
            if (block.id) toolUseIdToName.set(block.id, block.name);
            // Preserve full Bash commands; truncate other tool inputs for size.
            let inputKey: string;
            if (
              block.name === 'Bash'
              && block.input
              && typeof block.input === 'object'
              && typeof (block.input as { command?: unknown }).command === 'string'
            ) {
              inputKey = (block.input as { command: string }).command;
            } else {
              inputKey = block.input ? JSON.stringify(block.input).slice(0, 200) : '';
            }
            // Dedup key stays truncated so identical short prefixes collapse the same as before.
            const toolSig = `${block.name}:${inputKey.slice(0, 200)}`;
            if (!seenTools.has(toolSig)) {
              seenTools.add(toolSig);
              textParts.push(`[Tool: ${block.name}] ${inputKey}`);
            }
          }
          // Preserve tool results for whitelisted tools (e.g., live message reads).
          if (block.type === 'tool_result' && block.tool_use_id) {
            const toolName = toolUseIdToName.get(block.tool_use_id);
            if (toolName && WHITELISTED_TOOL_RESULTS.has(toolName)) {
              const resultText = extractToolResultText(block.content);
              if (resultText) {
                textParts.push(`[Tool Result: ${toolName}] ${resultText}`);
              }
            }
          }
        }
        content = textParts.join('\n');
      }

      if (content) {
        messages.push({
          role: entry.type as 'user' | 'assistant',
          content,
          timestamp: entry.timestamp ? new Date(entry.timestamp) : undefined,
        });
      }
    } catch {
      // Skip unparseable lines
    }
  }

  const filename = path.basename(filePath);
  const { sessionId } = extractSessionId(filename, 'project');

  // Determine primary model (most frequent)
  let primaryModel: string | null = null;
  let maxCount = 0;
  for (const [model, count] of modelCounts) {
    if (count > maxCount) {
      primaryModel = model;
      maxCount = count;
    }
  }

  return {
    sessionId,
    summary,
    messages,
    startedAt,
    endedAt,
    fileSize: stat.size,
    filePath,
    usage: {
      model: primaryModel,
      totalInputTokens,
      totalOutputTokens,
      totalCacheCreationTokens,
      totalCacheReadTokens,
      contextWindowTokens: lastContextWindowTokens,
    },
  };
}

/**
 * Parse a Codex CLI session file.
 */
async function parseCodexSession(filePath: string): Promise<ParsedSession> {
  const stat = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const messages: ParsedMessage[] = [];
  let startedAt: Date | undefined;
  let endedAt: Date | undefined;
  const modelCounts = new Map<string, number>();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let lastContextWindowTokens = 0;
  const toolUseIdToName = new Map<string, string>();

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line);

      // Track timestamps
      if (entry.timestamp) {
        const ts = new Date(entry.timestamp);
        if (!startedAt || ts < startedAt) startedAt = ts;
        if (!endedAt || ts > endedAt) endedAt = ts;
      }

      // Session meta
      if (entry.type === 'session_meta') {
        if (entry.payload?.timestamp) {
          startedAt = new Date(entry.payload.timestamp);
        }
        continue;
      }

      // Messages
      if (entry.type === 'message') {
        const role = entry.role as 'user' | 'assistant';
        if (!['user', 'assistant'].includes(role)) continue;

        // Track usage from assistant messages
        if (role === 'assistant' && entry.usage) {
          const u = entry.usage;
          totalInputTokens += (u.input_tokens || 0);
          totalOutputTokens += (u.output_tokens || 0);
          totalCacheCreationTokens += (u.cache_creation_input_tokens || 0);
          totalCacheReadTokens += (u.cache_read_input_tokens || 0);
          lastContextWindowTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        }
        if (role === 'assistant' && entry.model) {
          modelCounts.set(entry.model, (modelCounts.get(entry.model) || 0) + 1);
        }

        let content = '';
        if (Array.isArray(entry.content)) {
          const parts: string[] = [];
          const seenTools = new Set<string>();
          for (const c of entry.content) {
            if ((c.type === 'text' || c.type === 'input_text' || c.type === 'output_text') && c.text) {
              parts.push(c.text);
            }
            if (c.type === 'tool_use' && c.name) {
              if (c.id) toolUseIdToName.set(c.id, c.name);
              // Preserve full Bash commands; truncate other tool inputs for size.
              let inputKey: string;
              if (
                c.name === 'Bash'
                && c.input
                && typeof c.input === 'object'
                && typeof (c.input as { command?: unknown }).command === 'string'
              ) {
                inputKey = (c.input as { command: string }).command;
              } else {
                inputKey = c.input ? JSON.stringify(c.input).slice(0, 200) : '';
              }
              const toolSig = `${c.name}:${inputKey.slice(0, 200)}`;
              if (!seenTools.has(toolSig)) {
                seenTools.add(toolSig);
                parts.push(`[Tool: ${c.name}] ${inputKey}`);
              }
            }
            if (c.type === 'tool_result' && c.tool_use_id) {
              const toolName = toolUseIdToName.get(c.tool_use_id);
              if (toolName && WHITELISTED_TOOL_RESULTS.has(toolName)) {
                const resultText = extractToolResultText(c.content);
                if (resultText) {
                  parts.push(`[Tool Result: ${toolName}] ${resultText}`);
                }
              }
            }
          }
          content = parts.filter(Boolean).join('\n');
        } else if (typeof entry.content === 'string') {
          content = entry.content;
        }

        if (content) {
          messages.push({
            role,
            content,
            timestamp: entry.timestamp ? new Date(entry.timestamp) : undefined,
          });
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }

  const filename = path.basename(filePath);
  const { sessionId, name } = extractSessionId(filename, 'date');

  // Determine primary model (most frequent)
  let primaryModel: string | null = null;
  let maxCount = 0;
  for (const [model, count] of modelCounts) {
    if (count > maxCount) {
      primaryModel = model;
      maxCount = count;
    }
  }

  return {
    sessionId,
    name,
    messages,
    startedAt,
    endedAt,
    fileSize: stat.size,
    filePath,
    usage: {
      model: primaryModel,
      totalInputTokens,
      totalOutputTokens,
      totalCacheCreationTokens,
      totalCacheReadTokens,
      contextWindowTokens: lastContextWindowTokens,
    },
  };
}

// ── Chunking ────────────────────────────────────────────────────────

/**
 * Chunk messages into groups targeting CHUNK_TARGET_SIZE.
 * Breaks at message boundaries for context coherence.
 */
function chunkMessages(messages: ParsedMessage[]): SessionChunk[] {
  if (messages.length === 0) return [];

  const chunks: SessionChunk[] = [];
  let currentContent: string[] = [];
  let currentSize = 0;
  let currentMessageCount = 0;
  let chunkIndex = 0;

  for (const msg of messages) {
    const formatted = `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`;
    const msgSize = formatted.length;

    // If adding this message exceeds target and we have content, start new chunk
    if (currentSize + msgSize > CHUNK_TARGET_SIZE && currentContent.length > 0) {
      chunks.push({
        chunkIndex,
        content: currentContent.join('\n\n'),
        messageCount: currentMessageCount,
      });
      chunkIndex++;
      currentContent = [];
      currentSize = 0;
      currentMessageCount = 0;
    }

    currentContent.push(formatted);
    currentSize += msgSize + 2; // +2 for \n\n separator
    currentMessageCount++;
  }

  // Don't leave tiny trailing chunks - merge with previous if too small
  if (currentContent.length > 0) {
    if (currentSize < CHUNK_MIN_SIZE && chunks.length > 0) {
      const lastChunk = chunks[chunks.length - 1];
      lastChunk.content += '\n\n' + currentContent.join('\n\n');
      lastChunk.messageCount += currentMessageCount;
    } else {
      chunks.push({
        chunkIndex,
        content: currentContent.join('\n\n'),
        messageCount: currentMessageCount,
      });
    }
  }

  return chunks;
}

// ── Database Operations ─────────────────────────────────────────────

/**
 * Get assistant ID by handle.
 */
async function getAssistantId(handle: string): Promise<string | null> {
  const result = await querySingle<{ id: string }>(
    'SELECT id FROM assistants WHERE handle = $1',
    [handle]
  );
  return result?.id ?? null;
}

/**
 * Get existing session by assistant and session ID.
 */
async function getExistingSession(
  assistantId: string,
  sessionId: string
): Promise<{ id: string; file_size: number } | null> {
  const result = await querySingle<{ id: string; file_size: string }>(
    'SELECT id, file_size FROM sessions WHERE assistant_id = $1 AND session_id = $2',
    [assistantId, sessionId]
  );
  if (!result) return null;
  return { id: result.id, file_size: parseInt(result.file_size, 10) };
}

/**
 * Load all projects with paths from DB (cached per sync cycle).
 */
async function loadProjectMap(): Promise<Map<string, string>> {
  const projects = await query<{ id: string; path: string }>(
    `SELECT id, path FROM projects WHERE path IS NOT NULL AND path != ''`
  );

  // Map encoded dir name -> project ID
  const map = new Map<string, string>();
  for (const proj of projects) {
    const resolvedPath = proj.path.startsWith('~')
      ? path.join(os.homedir(), proj.path.slice(1))
      : proj.path;
    const encoded = resolvedPath.replace(/\//g, '-');
    map.set(encoded, proj.id);
  }
  return map;
}

/**
 * Try to match a session file path to a khef project.
 * Uses pre-loaded project map to avoid per-session DB queries.
 */
function matchProject(filePath: string, projectMap: Map<string, string>): string | null {
  // For Claude Code: extract dir name from session path
  // e.g., ~/.claude/projects/-Users-roger-projects-khef/session.jsonl
  const claudeMatch = filePath.match(/\.claude\/projects\/(-[^/]+)\//);
  if (claudeMatch) {
    return projectMap.get(claudeMatch[1]) ?? null;
  }

  return null;
}

/**
 * Upsert a session and its chunks.
 */
async function upsertSession(
  assistantId: string,
  parsed: ParsedSession,
  projectId: string | null
): Promise<{ isNew: boolean; chunksCreated: number }> {
  const existing = await getExistingSession(assistantId, parsed.sessionId);
  const chunks = chunkMessages(parsed.messages);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let sessionDbId: string;
    let isNew = false;

    // Look up nickname from sessions (may be null if session already exists)
    const nicknameRow = await client.query<{ nickname: string | null }>(
      `SELECT nickname FROM sessions WHERE session_id = $1`,
      [parsed.sessionId]
    );
    const nickname = nicknameRow.rows[0]?.nickname ?? null;

    if (existing) {
      // Update existing session
      await client.query(
        `UPDATE sessions SET
          project_id = COALESCE($1, project_id),
          name = COALESCE($2, name),
          summary = COALESCE($3, summary),
          message_count = $4,
          file_size = $5,
          file_path = $6,
          started_at = $7,
          ended_at = $8,
          nickname = COALESCE($9, nickname),
          model = COALESCE($10, model),
          total_input_tokens = $11,
          total_output_tokens = $12,
          total_cache_creation_tokens = $13,
          total_cache_read_tokens = $14,
          context_window_tokens = $15,
          updated_at = NOW()
        WHERE id = $16`,
        [
          projectId,
          parsed.name,
          parsed.summary,
          parsed.messages.length,
          parsed.fileSize,
          parsed.filePath,
          parsed.startedAt,
          parsed.endedAt,
          nickname,
          parsed.usage.model,
          parsed.usage.totalInputTokens,
          parsed.usage.totalOutputTokens,
          parsed.usage.totalCacheCreationTokens,
          parsed.usage.totalCacheReadTokens,
          parsed.usage.contextWindowTokens,
          existing.id,
        ]
      );
      sessionDbId = existing.id;

      // Delete old chunks
      await client.query('DELETE FROM session_chunks WHERE session_id = $1', [sessionDbId]);
    } else {
      // Insert new session
      const result = await client.query<{ id: string }>(
        `INSERT INTO sessions (
          session_id, assistant_id, project_id, name, summary,
          message_count, file_size, file_path, started_at, ended_at, nickname,
          model, total_input_tokens, total_output_tokens,
          total_cache_creation_tokens, total_cache_read_tokens, context_window_tokens
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING id`,
        [
          parsed.sessionId,
          assistantId,
          projectId,
          parsed.name,
          parsed.summary,
          parsed.messages.length,
          parsed.fileSize,
          parsed.filePath,
          parsed.startedAt,
          parsed.endedAt,
          nickname,
          parsed.usage.model,
          parsed.usage.totalInputTokens,
          parsed.usage.totalOutputTokens,
          parsed.usage.totalCacheCreationTokens,
          parsed.usage.totalCacheReadTokens,
          parsed.usage.contextWindowTokens,
        ]
      );
      sessionDbId = result.rows[0].id;
      isNew = true;
    }

    // Insert chunks
    for (const chunk of chunks) {
      await client.query(
        `INSERT INTO session_chunks (session_id, chunk_index, content, message_count)
        VALUES ($1, $2, $3, $4)`,
        [sessionDbId, chunk.chunkIndex, chunk.content, chunk.messageCount]
      );
    }

    await client.query('COMMIT');
    return { isNew, chunksCreated: chunks.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Directory Scanning ──────────────────────────────────────────────

/**
 * Find all session files for Claude Code.
 */
export function findClaudeSessions(basePath: string): string[] {
  const files: string[] = [];

  if (!fs.existsSync(basePath)) return files;

  const projectDirs = fs.readdirSync(basePath, { withFileTypes: true })
    .filter(e => e.isDirectory());

  for (const dir of projectDirs) {
    const dirPath = path.join(basePath, dir.name);
    try {
      const jsonlFiles = fs.readdirSync(dirPath)
        .filter(f => f.endsWith('.jsonl'));

      for (const file of jsonlFiles) {
        files.push(path.join(dirPath, file));
      }
    } catch {
      // Directory may be inaccessible
    }
  }

  return files;
}

/**
 * Find all session files for Codex CLI (recursive date structure).
 */
export function findCodexSessions(basePath: string): string[] {
  const files: string[] = [];

  function scanDir(dir: string) {
    if (!fs.existsSync(dir)) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(fullPath);
        }
      }
    } catch {
      // Directory may be inaccessible
    }
  }

  scanDir(basePath);
  return files;
}

// ── Main Sync ───────────────────────────────────────────────────────

/**
 * Sync sessions for a specific assistant.
 * Processes at most BATCH_SIZE sessions per call to avoid overwhelming first-time syncs.
 */
export async function syncAssistantSessions(
  assistantHandle: string,
  projectMap: Map<string, string>,
  options?: { force?: boolean }
): Promise<SessionSyncResult> {
  const result: SessionSyncResult = {
    synced: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    chunks_created: 0,
  };

  const config = SESSION_PATHS[assistantHandle];
  if (!config) return result;

  const assistantId = await getAssistantId(assistantHandle);
  if (!assistantId) return result;

  // Find session files
  const files = config.structure === 'project'
    ? findClaudeSessions(config.basePath)
    : findCodexSessions(config.basePath);

  const batchLimit = options?.force ? Infinity : BATCH_SIZE;
  let processed = 0;

  for (const filePath of files) {
    // Stop after batch limit (unlimited for force syncs)
    if (processed >= batchLimit) break;

    try {
      const stat = fs.statSync(filePath);
      const filename = path.basename(filePath);
      const { sessionId } = extractSessionId(filename, config.structure);

      // Check if already synced with same size (skip unless forced)
      if (!options?.force) {
        const existing = await getExistingSession(assistantId, sessionId);
        if (existing && existing.file_size === stat.size) {
          result.skipped++;
          continue;
        }
      }

      // Parse session
      const parsed = config.structure === 'project'
        ? await parseClaudeSession(filePath)
        : await parseCodexSession(filePath);

      if (parsed.messages.length === 0) {
        result.skipped++;
        continue;
      }

      // Try to match project
      const projectId = matchProject(filePath, projectMap);

      // Upsert session and chunks
      const { isNew, chunksCreated } = await upsertSession(assistantId, parsed, projectId);

      if (isNew) {
        result.synced++;
      } else {
        result.updated++;
      }
      result.chunks_created += chunksCreated;
      processed++;
    } catch (err) {
      log.error({ err, filePath }, 'Error processing session');
      result.errors++;
      processed++;
    }
  }

  return result;
}

/**
 * Determine which assistant handle owns a session file based on its path.
 * Returns null if the path doesn't match any known assistant.
 */
export function assistantHandleForFile(filePath: string): string | null {
  for (const [handle, config] of Object.entries(SESSION_PATHS)) {
    if (filePath.startsWith(config.basePath + path.sep) || filePath.startsWith(config.basePath + '/')) {
      return handle;
    }
  }
  return null;
}

export interface SingleFileSyncResult {
  skipped: boolean;
  isNew: boolean;
  chunksCreated: number;
  messageDelta: number;
  tokenInputDelta: number;
  tokenOutputDelta: number;
  parseMs: number;
  upsertMs: number;
  sessionId: string;
  projectId: string | null;
  messageCount: number;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * Parse and upsert a single session file. Used by the file watcher to react
 * to fs events without scanning the whole directory tree.
 */
export async function syncOneSessionFile(
  filePath: string,
  projectMap: Map<string, string>
): Promise<SingleFileSyncResult | null> {
  const handle = assistantHandleForFile(filePath);
  if (!handle) return null;

  const config = SESSION_PATHS[handle];
  const assistantId = await getAssistantId(handle);
  if (!assistantId) return null;

  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  const filename = path.basename(filePath);
  const { sessionId } = extractSessionId(filename, config.structure);

  const existing = await getExistingSession(assistantId, sessionId);
  if (existing && existing.file_size === stat.size) {
    return {
      skipped: true,
      isNew: false,
      chunksCreated: 0,
      messageDelta: 0,
      tokenInputDelta: 0,
      tokenOutputDelta: 0,
      parseMs: 0,
      upsertMs: 0,
      sessionId,
      projectId: null,
      messageCount: 0,
      model: null,
      startedAt: null,
      endedAt: null,
    };
  }

  const priorMessageCount = await getSessionMessageCount(assistantId, sessionId);
  const priorTokens = await getSessionTokenTotals(assistantId, sessionId);

  const parseStart = Date.now();
  const parsed = config.structure === 'project'
    ? await parseClaudeSession(filePath)
    : await parseCodexSession(filePath);
  const parseMs = Date.now() - parseStart;

  if (parsed.messages.length === 0) {
    return {
      skipped: true,
      isNew: false,
      chunksCreated: 0,
      messageDelta: 0,
      tokenInputDelta: 0,
      tokenOutputDelta: 0,
      parseMs,
      upsertMs: 0,
      sessionId,
      projectId: null,
      messageCount: 0,
      model: null,
      startedAt: null,
      endedAt: null,
    };
  }

  const projectId = matchProject(filePath, projectMap);
  const upsertStart = Date.now();
  const { isNew, chunksCreated } = await upsertSession(assistantId, parsed, projectId);
  const upsertMs = Date.now() - upsertStart;

  return {
    skipped: false,
    isNew,
    chunksCreated,
    messageDelta: parsed.messages.length - priorMessageCount,
    tokenInputDelta: parsed.usage.totalInputTokens - priorTokens.input,
    tokenOutputDelta: parsed.usage.totalOutputTokens - priorTokens.output,
    parseMs,
    upsertMs,
    sessionId,
    projectId,
    messageCount: parsed.messages.length,
    model: parsed.usage.model,
    startedAt: parsed.startedAt ? parsed.startedAt.toISOString() : null,
    endedAt: parsed.endedAt ? parsed.endedAt.toISOString() : null,
  };
}

async function getSessionMessageCount(assistantId: string, sessionId: string): Promise<number> {
  const row = await querySingle<{ message_count: string }>(
    'SELECT message_count FROM sessions WHERE assistant_id = $1 AND session_id = $2',
    [assistantId, sessionId]
  );
  return row ? parseInt(row.message_count, 10) : 0;
}

async function getSessionTokenTotals(
  assistantId: string,
  sessionId: string
): Promise<{ input: number; output: number }> {
  const row = await querySingle<{ total_input_tokens: string; total_output_tokens: string }>(
    'SELECT total_input_tokens, total_output_tokens FROM sessions WHERE assistant_id = $1 AND session_id = $2',
    [assistantId, sessionId]
  );
  if (!row) return { input: 0, output: 0 };
  return {
    input: parseInt(row.total_input_tokens, 10) || 0,
    output: parseInt(row.total_output_tokens, 10) || 0,
  };
}

/**
 * Expose the cached project map loader so the watcher can refresh periodically.
 */
export async function loadSessionProjectMap(): Promise<Map<string, string>> {
  return loadProjectMap();
}

/**
 * Sync sessions for all supported assistants.
 */
export async function syncAllSessions(
  options?: { force?: boolean }
): Promise<SessionSyncResult> {
  const total: SessionSyncResult = {
    synced: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    chunks_created: 0,
  };

  // Load project map once for the entire cycle
  const projectMap = await loadProjectMap();

  for (const handle of Object.keys(SESSION_PATHS)) {
    const result = await syncAssistantSessions(handle, projectMap, options);
    total.synced += result.synced;
    total.updated += result.updated;
    total.skipped += result.skipped;
    total.errors += result.errors;
    total.chunks_created += result.chunks_created;
  }

  // Only log when actual work was done
  if (total.synced > 0 || total.updated > 0 || total.errors > 0) {
    log.info({ synced: total.synced, updated: total.updated, errors: total.errors, chunks: total.chunks_created }, 'Sync complete');
  }

  return total;
}

/**
 * Get sync status.
 */
export async function getSessionSyncStatus(): Promise<{
  total_sessions: number;
  total_chunks: number;
  by_assistant: Array<{ assistant_handle: string; session_count: number; chunk_count: number }>;
}> {
  const result = await query<{
    assistant_handle: string;
    session_count: string;
    chunk_count: string;
  }>(`
    SELECT
      a.handle as assistant_handle,
      COUNT(DISTINCT s.id) as session_count,
      COALESCE(SUM(sc.chunk_count), 0) as chunk_count
    FROM assistants a
    LEFT JOIN sessions s ON s.assistant_id = a.id
    LEFT JOIN (
      SELECT session_id, COUNT(*) as chunk_count
      FROM session_chunks
      GROUP BY session_id
    ) sc ON sc.session_id = s.id
    GROUP BY a.handle
    ORDER BY a.handle
  `);

  const byAssistant = result.map(r => ({
    assistant_handle: r.assistant_handle,
    session_count: parseInt(r.session_count, 10),
    chunk_count: parseInt(r.chunk_count, 10),
  }));

  return {
    total_sessions: byAssistant.reduce((sum, a) => sum + a.session_count, 0),
    total_chunks: byAssistant.reduce((sum, a) => sum + a.chunk_count, 0),
    by_assistant: byAssistant,
  };
}
