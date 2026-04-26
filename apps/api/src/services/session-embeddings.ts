/**
 * Session embedding service.
 * Extracts clean content from session transcripts and embeds for vector search.
 * Uses kvec (pgvector) for storage — no external vector provider needed.
 */

import { workerLogger } from '../lib/logger';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import pool from '../db/client';
import { getSessionsCollection } from './kvec-service';
import type { Collection } from '@khef/kvec';
import {
  getSessionsBasePath,
  validateProjectDir,
  validateSessionId,
  resolveProjectDir,
} from './sessions';

const log = workerLogger.child({ component: 'session-embeddings' });

export interface SessionSyncResult {
  synced: number;
  skipped: number;
  errors: number;
  chunks_created: number;
}

/**
 * Extract conversation content from a session file.
 * Includes: user text prompts, assistant text responses, thinking blocks, tool calls.
 * Excludes: tool results, file snapshots, progress updates.
 */
async function extractSessionContent(filePath: string): Promise<{ summary?: string; content: string }> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const contentParts: string[] = [];
  let summary: string | undefined;

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line);

      // Capture summary if present
      if (entry.type === 'summary' && entry.summary) {
        summary = entry.summary;
        continue;
      }

      // Skip non-conversation entries
      if (!['user', 'assistant'].includes(entry.type)) continue;

      // Extract text content from message
      const message = entry.message;
      if (!message?.content || !Array.isArray(message.content)) continue;

      const seenTools = new Set<string>();
      for (const block of message.content) {
        // Include text blocks
        if (block.type === 'text' && block.text) {
          const role = entry.type === 'user' ? 'User' : 'Assistant';
          contentParts.push(`${role}: ${block.text}`);
        }

        // Include thinking blocks
        if (block.type === 'thinking' && block.thinking) {
          contentParts.push(`Thinking: ${block.thinking}`);
        }

        // Include tool calls (deduplicated within message)
        if (block.type === 'tool_use' && block.name) {
          const inputKey = block.input
            ? JSON.stringify(block.input).slice(0, 200)
            : '';
          const toolSig = `${block.name}:${inputKey}`;
          if (!seenTools.has(toolSig)) {
            seenTools.add(toolSig);
            contentParts.push(`[Tool: ${block.name}] ${inputKey}`);
          }
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }

  return {
    summary,
    content: contentParts.join('\n\n'),
  };
}

/**
 * Filter out thinking blocks from content.
 */
function filterThinking(content: string): string {
  return content
    .split('\n\n')
    .filter(para => !para.startsWith('Thinking:'))
    .join('\n\n');
}

/**
 * Filter out tool call blocks from content.
 */
function filterToolCalls(content: string): string {
  return content
    .split('\n\n')
    .filter(para => !para.startsWith('[Tool:'))
    .join('\n\n');
}

/**
 * Build a stable document ID for a session in kvec.
 */
function sessionDocId(assistantHandle: string, projectDir: string, sessionId: string): string {
  return `session:${assistantHandle}/${projectDir}/${sessionId}`;
}

/**
 * Sync session embeddings for a project or all projects.
 */
export async function syncSessionEmbeddings(
  assistantHandle: string,
  options?: {
    projectDir?: string;
    sessionId?: string;
    force?: boolean;
  }
): Promise<SessionSyncResult> {
  const result: SessionSyncResult = { synced: 0, skipped: 0, errors: 0, chunks_created: 0 };

  const collection = await getSessionsCollection();

  const basePath = getSessionsBasePath(assistantHandle);
  if (!basePath || !fs.existsSync(basePath)) {
    return result;
  }

  // Determine which project directories to process
  let projectDirs: string[];
  if (options?.projectDir) {
    const resolved = await resolveProjectDir(options.projectDir);
    validateProjectDir(resolved);
    projectDirs = [resolved];
  } else {
    projectDirs = fs.readdirSync(basePath, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  }

  // Process each project directory
  for (const projectDir of projectDirs) {
    const dirPath = path.join(basePath, projectDir);
    let jsonlFiles: string[];

    try {
      jsonlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    // Filter to a single session if requested
    if (options?.sessionId) {
      jsonlFiles = jsonlFiles.filter(f => f.replace('.jsonl', '') === options.sessionId);
    }

    for (const file of jsonlFiles) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(dirPath, file);

      try {
        validateSessionId(sessionId);

        // Extract and chunk content
        const { summary, content } = await extractSessionContent(filePath);

        if (!content || content.length < 50) {
          result.skipped++;
          continue;
        }

        const docId = sessionDocId(assistantHandle, projectDir, sessionId);
        const metadata = {
          session_id: sessionId,
          project_dir: projectDir,
          assistant_handle: assistantHandle,
          summary: summary || '',
          type: 'session',
        };

        // Force mode: delete existing document to bypass content-hash dedup
        if (options?.force) {
          await collection.deleteDocument(docId);
        }

        const chunksCreated = await collection.ingestContent(docId, content, {
          language: 'text',
          metadata,
        });

        if (chunksCreated === 0) {
          result.skipped++;
        } else {
          result.synced++;
          result.chunks_created += chunksCreated;
        }
      } catch (err) {
        log.error({ err, sessionId }, 'Error processing session');
        result.errors++;
      }
    }
  }

  log.info({ synced: result.synced, skipped: result.skipped, errors: result.errors, chunks: result.chunks_created }, 'Sync complete');

  return result;
}

/**
 * Get sync status for session embeddings.
 */
export async function getSessionEmbeddingStatus(
  assistantHandle: string,
  projectDir?: string
): Promise<{
  embedded_sessions: number;
  total_chunks: number;
  last_sync?: string;
}> {
  const collection = await getSessionsCollection();

  // Build metadata filter
  const filter: Record<string, unknown> = { assistant_handle: assistantHandle };
  if (projectDir) {
    const resolved = await resolveProjectDir(projectDir);
    filter.project_dir = resolved;
  }

  const result = await pool.query<{ sessions: string; chunks: string; last_sync: string | null }>(`
    SELECT
      COUNT(DISTINCT f.id) as sessions,
      COUNT(c.id) as chunks,
      MAX(f.updated_at) as last_sync
    FROM kvec.tracked_files f
    LEFT JOIN kvec.chunks c ON c.file_id = f.id
    WHERE f.collection_id = $1
      AND f.metadata @> $2::jsonb
  `, [collection.id, JSON.stringify(filter)]);

  const row = result.rows[0];

  return {
    embedded_sessions: parseInt(row.sessions, 10),
    total_chunks: parseInt(row.chunks, 10),
    last_sync: row.last_sync || undefined,
  };
}

/**
 * Enrich search results with nickname and db_id from the session_search_details view.
 */
async function enrichWithSessionDetails<T extends { session_id: string }>(
  results: T[]
): Promise<(T & { nickname?: string; db_id?: string })[]> {
  if (results.length === 0) return results;

  const sessionIds = [...new Set(results.map(r => r.session_id).filter(Boolean))];
  if (sessionIds.length === 0) return results;

  const placeholders = sessionIds.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await pool.query<{ session_id: string; nickname: string | null; db_id: string }>(
    `SELECT session_id, nickname, db_id FROM session_search_details WHERE session_id IN (${placeholders})`,
    sessionIds
  );

  const detailMap = new Map(rows.rows.map(r => [r.session_id, r]));

  return results.map(r => {
    const detail = detailMap.get(r.session_id);
    return {
      ...r,
      nickname: detail?.nickname || undefined,
      db_id: detail?.db_id || undefined,
    };
  });
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'was', 'were', 'are',
  'you', 'your', 'have', 'has', 'not', 'but', 'any', 'all', 'what', 'how',
  'why', 'when', 'who', 'can', 'get', 'set', 'use', 'using', 'into',
]);

function extractQueryTokens(queryText: string): string[] {
  const tokens = queryText
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(tokens)];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildTokenBoundaryRegex(tokens: string[]): RegExp | null {
  if (tokens.length === 0) return null;
  const alt = tokens.map(escapeRegex).join('|');
  // Use \b word boundaries so "useLiveUpdates" doesn't match "update".
  return new RegExp(`\\b(?:${alt})\\b`, 'i');
}

/**
 * Blend similarity score with recency decay (exp(-ageDays / halfLifeDays))
 * and boost results where the session summary matches query tokens.
 * Re-sorts by the blended score.
 */
async function applyRecencyAndSummaryBoost<T extends { session_id: string; score: number }>(
  results: T[],
  queryText: string,
  halfLifeDays = 30,
  summaryBoost = 2.0,
): Promise<T[]> {
  if (results.length === 0) return results;
  const sessionIds = [...new Set(results.map(r => r.session_id).filter(Boolean))];
  if (sessionIds.length === 0) return results;

  const placeholders = sessionIds.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await pool.query<{
    session_id: string;
    ref_date: string | null;
    summary: string | null;
    name: string | null;
  }>(
    `SELECT session_id,
            COALESCE(started_at, ended_at, updated_at, created_at)::text as ref_date,
            summary,
            name
       FROM sessions
      WHERE session_id IN (${placeholders})`,
    sessionIds
  );

  // Same session_id can appear under multiple assistants — keep the most recent row.
  type SessionMeta = { ts: number; haystack: string };
  const metaMap = new Map<string, SessionMeta>();
  for (const row of rows.rows) {
    if (!row.ref_date) continue;
    const ts = new Date(row.ref_date).getTime();
    const existing = metaMap.get(row.session_id);
    if (existing === undefined || ts > existing.ts) {
      const haystack = `${row.summary || ''} ${row.name || ''}`.toLowerCase();
      metaMap.set(row.session_id, { ts, haystack });
    }
  }

  const tokens = extractQueryTokens(queryText);
  const tokenRegex = buildTokenBoundaryRegex(tokens);
  const now = Date.now();
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;

  const adjusted = results.map(r => {
    const meta = metaMap.get(r.session_id);
    if (!meta) return r;
    const ageMs = Math.max(0, now - meta.ts);
    const decay = Math.exp(-ageMs / halfLifeMs);
    const matched = tokenRegex ? tokenRegex.test(meta.haystack) : false;
    const boost = matched ? summaryBoost : 1.0;
    return { ...r, score: r.score * decay * boost };
  });

  adjusted.sort((a, b) => b.score - a.score);
  return adjusted;
}

/**
 * Search sessions using vector similarity or keyword matching.
 */
export async function searchSessions(
  queryText: string,
  options?: {
    assistantHandle?: string;
    projectDir?: string;
    sessionId?: string;
    excludeSessionId?: string;
    limit?: number;
    includeThinking?: boolean;
    includeToolCalls?: boolean;
    mode?: 'keyword' | 'semantic';
  }
): Promise<Array<{
  session_id: string;
  project_dir: string;
  assistant_handle: string;
  chunk_index: number;
  chunk_count: number;
  summary: string;
  score: number;
  content?: string;
  nickname?: string;
  db_id?: string;
}>> {
  const collection = await getSessionsCollection();
  const limit = options?.limit || 10;
  const mode = options?.mode || 'semantic';

  // Build metadata filter for kvec
  const filter: Record<string, unknown> = { type: 'session' };
  if (options?.assistantHandle) {
    filter.assistant_handle = options.assistantHandle;
  }
  if (options?.projectDir) {
    const resolved = await resolveProjectDir(options.projectDir);
    filter.project_dir = resolved;
  }
  if (options?.sessionId) {
    filter.session_id = options.sessionId;
  }

  // Request extra results when excluding, to compensate for post-filter removal
  const queryLimit = options?.excludeSessionId ? limit + 5 : limit;

  if (mode === 'keyword') {
    const results = await searchSessionsKeyword(collection, queryText, filter, queryLimit, options?.includeThinking, options?.includeToolCalls);
    const filtered = options?.excludeSessionId
      ? results.filter(r => r.session_id !== options.excludeSessionId).slice(0, limit)
      : results;
    return enrichWithSessionDetails(filtered);
  }

  // Semantic search via kvec
  // Pull more candidates than we need so recency decay can reorder freely
  // without starving the final list.
  const candidatePool = Math.max(queryLimit * 3, 30);
  const results = await collection.query(queryText, { limit: candidatePool, filter });

  const mapped = results.map(r => {
    const meta = (r.metadata || {}) as Record<string, unknown>;
    let content = r.content || '';
    if (options?.includeThinking === false) content = filterThinking(content);
    if (options?.includeToolCalls !== true) content = filterToolCalls(content);

    return {
      session_id: (meta.session_id as string) || '',
      project_dir: (meta.project_dir as string) || '',
      assistant_handle: (meta.assistant_handle as string) || '',
      chunk_index: r.chunkIndex,
      chunk_count: 0,
      summary: (meta.summary as string) || '',
      score: r.score,
      content,
    };
  });

  const adjusted = await applyRecencyAndSummaryBoost(mapped, queryText);

  const filtered = options?.excludeSessionId
    ? adjusted.filter(r => r.session_id !== options.excludeSessionId).slice(0, limit)
    : adjusted.slice(0, limit);
  return enrichWithSessionDetails(filtered);
}

/**
 * Keyword search: direct SQL query on chunk content.
 */
async function searchSessionsKeyword(
  collection: Collection,
  queryText: string,
  filter: Record<string, unknown>,
  limit: number,
  includeThinking?: boolean,
  includeToolCalls?: boolean,
): Promise<Array<{
  session_id: string;
  project_dir: string;
  assistant_handle: string;
  chunk_index: number;
  chunk_count: number;
  summary: string;
  score: number;
  content?: string;
  nickname?: string;
  db_id?: string;
}>> {
  const result = await pool.query<{
    content: string;
    chunk_index: number;
    metadata: Record<string, unknown>;
    file_path: string;
  }>(`
    SELECT c.content, c.chunk_index, c.metadata, f.file_path
    FROM kvec.chunks c
    JOIN kvec.tracked_files f ON f.id = c.file_id
    WHERE f.collection_id = $1
      AND c.content ILIKE '%' || $2 || '%'
      AND c.metadata @> $3::jsonb
    ORDER BY f.updated_at DESC
    LIMIT $4
  `, [collection.id, queryText, JSON.stringify(filter), limit]);

  return result.rows.map(row => {
    const meta = row.metadata || {};
    let content = row.content || '';
    if (includeThinking === false) content = filterThinking(content);
    if (includeToolCalls !== true) content = filterToolCalls(content);

    return {
      session_id: (meta.session_id as string) || '',
      project_dir: (meta.project_dir as string) || '',
      assistant_handle: (meta.assistant_handle as string) || '',
      chunk_index: row.chunk_index,
      chunk_count: 0,
      summary: (meta.summary as string) || '',
      score: 1, // keyword match = score 1
      content,
    };
  });
}
