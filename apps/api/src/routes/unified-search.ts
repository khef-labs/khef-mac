/**
 * Unified search route.
 * Single endpoint that fans out to all search backends in parallel
 * and returns consolidated, grouped results.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { VectorResult, Collection } from '@khef/kvec';
import pool from '../db/client';
import { query } from '../db/client';
import { normalizeWebsearchQuery } from '../utils/search-query';
import {
  getKvec,
  getMemoriesCollection,
  getSourceCollection,
  getCommitsCollection,
  getOrCreateDocsCollection,
  getOrCreateSlackCollection,
  getSessionsCollection,
} from '../services/kvec-service';

// ---------------------------------------------------------------------------
// Query auto-splitting (same logic as vector-search.ts)
// ---------------------------------------------------------------------------

const MAX_BIGRAMS = 5;

function splitQuery(q: string): string[] {
  const terms = q.trim().split(/\s+/);
  if (terms.length <= 3) return [q];

  const bigrams: string[] = [];
  for (let i = 0; i < terms.length - 1; i++) {
    bigrams.push(terms.slice(i, i + 2).join(' '));
  }

  if (bigrams.length <= MAX_BIGRAMS) return bigrams;

  const stride = (bigrams.length - 1) / (MAX_BIGRAMS - 1);
  return Array.from({ length: MAX_BIGRAMS }, (_, i) =>
    bigrams[Math.round(i * stride)]
  );
}

// ---------------------------------------------------------------------------
// Per-backend search functions
// ---------------------------------------------------------------------------

interface MemoryResult {
  id: string;
  project_handle: string;
  handle: string;
  title: string;
  type: string;
  status: string;
  updated_at: string;
  content_excerpt: string;
  score: number;
  mode: 'keyword' | 'semantic';
}

interface SourceResult {
  file_path: string;
  content: string;
  score: number;
  language: string | null;
  chunk_index: number;
}

interface CommitResult {
  sha: string;
  short_sha: string;
  message: string;
  author: string;
  date: string;
  repo: string;
  score: number;
}

interface SessionResult {
  session_id: string;
  assistant_handle: string;
  project_handle: string | null;
  name: string | null;
  excerpt: string;
  rank: number;
  mode: 'fulltext' | 'semantic';
}

interface DocResult {
  file_path: string;
  title: string | null;
  content: string;
  score: number;
  file_type: string | null;
  project_handle: string | null;
}

interface SlackResult {
  content: string;
  score: number;
  document_id: string;
  channel?: string;
}

interface UnifiedSearchResult {
  memories: MemoryResult[];
  source_code: SourceResult[];
  commits: CommitResult[];
  sessions: SessionResult[];
  docs: DocResult[];
  slack: SlackResult[];
  meta: {
    query: string;
    duration_ms: number;
    backends: string[];
    errors: string[];
  };
}

/**
 * Search memories using both keyword and semantic modes.
 * Merge and deduplicate, preferring highest score per memory.
 */
async function searchMemories(
  q: string,
  opts: { project_id?: string; limit: number; embedding?: number[] },
): Promise<MemoryResult[]> {
  const limit = opts.limit;

  // --- Keyword search ---
  const keywordPromise = (async (): Promise<MemoryResult[]> => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    // Build full-text search — use @@ operator for GIN index hit instead of ts_rank > 0
    conditions.push(`(
      m.content_tsv @@ websearch_to_tsquery('english', $${paramIndex})
      OR EXISTS (
        SELECT 1 FROM memory_chunks mc
        WHERE mc.memory_id = m.id
        AND mc.content_tsv @@ websearch_to_tsquery('english', $${paramIndex})
      )
    )`);
    params.push(normalizeWebsearchQuery(q));
    paramIndex++;

    if (opts.project_id) {
      conditions.push(`p.handle = $${paramIndex++}`);
      params.push(opts.project_id);
    }

    params.push(limit);

    const sql = `
      SELECT
        m.id,
        p.handle as project_handle,
        m.handle,
        m.title,
        mt.name as type,
        mts.status_value as status,
        m.updated_at,
        LEFT(m.content || '', 300) as content_excerpt,
        GREATEST(
          ts_rank(m.content_tsv, websearch_to_tsquery('english', $1)) * 1.0,
          COALESCE((
            SELECT MAX(ts_rank(mc.content_tsv, websearch_to_tsquery('english', $1)))
            FROM memory_chunks mc WHERE mc.memory_id = m.id
          ), 0) * 0.8
        ) as score
      FROM memories m
      JOIN memory_types mt ON mt.id = m.memory_type_id
      JOIN memory_type_statuses mts ON mts.id = m.status_id
      JOIN projects p ON p.id = m.project_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY score DESC
      LIMIT $${paramIndex}
    `;

    const rows = await pool.query(sql, params);
    return rows.rows.map((r: any) => ({
      id: r.id,
      project_handle: r.project_handle,
      handle: r.handle,
      title: r.title,
      type: r.type,
      status: r.status,
      updated_at: r.updated_at?.toISOString?.() ?? r.updated_at,
      content_excerpt: r.content_excerpt + (r.content_excerpt?.length >= 300 ? '...' : ''),
      score: parseFloat(r.score) || 0,
      mode: 'keyword' as const,
    }));
  })();

  // --- Semantic search ---
  const semanticPromise = (async (): Promise<MemoryResult[]> => {
    const collection = await getMemoriesCollection();
    const filter: Record<string, unknown> = {};
    if (opts.project_id) filter.project_id = opts.project_id;

    const queryOpts = {
      limit,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    };
    const vectorResults = opts.embedding
      ? await collection.queryWithEmbedding(opts.embedding, queryOpts)
      : await collection.query(q, queryOpts);

    if (vectorResults.length === 0) return [];

    // Deduplicate by memory_id
    const memoryScores = new Map<string, number>();
    for (const result of vectorResults) {
      const memoryId = (result.metadata as Record<string, unknown>)?.memory_id as string;
      if (!memoryId) continue;
      const existing = memoryScores.get(memoryId);
      if (!existing || result.score > existing) {
        memoryScores.set(memoryId, result.score);
      }
    }

    const memoryIds = [...memoryScores.keys()];
    if (memoryIds.length === 0) return [];

    const memoriesResult = await pool.query(`
      SELECT
        m.id,
        p.handle as project_handle,
        m.handle,
        m.title,
        mt.name as type,
        mts.status_value as status,
        m.updated_at,
        LEFT(m.content || '', 300) as content_excerpt
      FROM memories m
      JOIN memory_types mt ON mt.id = m.memory_type_id
      JOIN memory_type_statuses mts ON mts.id = m.status_id
      JOIN projects p ON p.id = m.project_id
      WHERE m.id = ANY($1::uuid[])
    `, [memoryIds]);

    const memoriesById = new Map(memoriesResult.rows.map((m: any) => [m.id, m]));

    const results: MemoryResult[] = [];
    for (const id of memoryIds) {
      const memory = memoriesById.get(id) as any;
      if (!memory) continue;
      results.push({
        id: memory.id,
        project_handle: memory.project_handle,
        handle: memory.handle,
        title: memory.title,
        type: memory.type,
        status: memory.status,
        updated_at: memory.updated_at?.toISOString?.() ?? memory.updated_at,
        content_excerpt: memory.content_excerpt + (memory.content_excerpt?.length >= 300 ? '...' : ''),
        score: memoryScores.get(id) || 0,
        mode: 'semantic' as const,
      });
    }
    return results;
  })();

  const [keywordResults, semanticResults] = await Promise.all([keywordPromise, semanticPromise]);

  // Merge: deduplicate by id, keep highest score, note which mode found it
  const merged = new Map<string, MemoryResult>();
  for (const r of [...keywordResults, ...semanticResults]) {
    const existing = merged.get(r.id);
    if (!existing || r.score > existing.score) {
      merged.set(r.id, r);
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Search source code with per-language fan-out.
 * Queries each known language in parallel, merges and deduplicates.
 */
async function searchSourceCode(
  q: string,
  opts: { repo?: string; limit: number; embedding?: number[] },
): Promise<SourceResult[]> {
  const collection = await getSourceCollection();
  if (!collection) return [];

  // Get available languages for this repo
  const langQuery = opts.repo
    ? `SELECT DISTINCT tf.language AS value
       FROM kvec.tracked_files tf
       JOIN kvec.collections c ON c.id = tf.collection_id
       LEFT JOIN kvec.repos r ON r.id = tf.repo_id
       WHERE c.name = 'kvec-source' AND tf.status = 'active'
         AND r.name = $1
         AND tf.language IS NOT NULL AND tf.language <> ''
       ORDER BY tf.language ASC`
    : `SELECT DISTINCT tf.language AS value
       FROM kvec.tracked_files tf
       JOIN kvec.collections c ON c.id = tf.collection_id
       WHERE c.name = 'kvec-source' AND tf.status = 'active'
         AND tf.language IS NOT NULL AND tf.language <> ''
       ORDER BY tf.language ASC`;

  const langRows = await pool.query<{ value: string }>(
    langQuery,
    opts.repo ? [opts.repo] : []
  );
  // Cap languages and serialize to avoid overwhelming the local embed service.
  // Prioritize common code languages over config/data formats.
  const PRIORITY_LANGS = ['typescript', 'javascript', 'python', 'css', 'shell', 'rust', 'go', 'java'];
  const MAX_LANGS = 4;

  const allLangs = langRows.rows.map(r => r.value);
  if (allLangs.length === 0) return [];

  // Sort: priority languages first, then alphabetical
  const sorted = allLangs.sort((a, b) => {
    const ai = PRIORITY_LANGS.indexOf(a);
    const bi = PRIORITY_LANGS.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });
  const languages = sorted.slice(0, MAX_LANGS);

  // Run one query per language sequentially to limit concurrent embed calls.
  // No query splitting here — per-language fan-out already provides diversity.
  const perLanguageLimit = Math.max(opts.limit, 10);
  const allResults: VectorResult[][] = [];

  for (const language of languages) {
    const queryOpts = {
      limit: perLanguageLimit,
      repoName: opts.repo,
      language,
    };
    const results = opts.embedding
      ? await collection.queryWithEmbedding(opts.embedding, queryOpts)
      : await collection.query(q, queryOpts);
    allResults.push(results);
  }

  // Merge and deduplicate by filePath:chunkIndex, keep max score
  const merged = new Map<string, VectorResult>();
  for (const results of allResults) {
    for (const r of results) {
      const key = `${r.filePath}:${r.chunkIndex}`;
      const existing = merged.get(key);
      if (!existing || r.score > existing.score) {
        merged.set(key, r);
      }
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit)
    .map(r => ({
      file_path: r.filePath,
      content: r.content,
      score: r.score,
      language: r.language,
      chunk_index: r.chunkIndex,
    }));
}

/**
 * Search commits with query splitting.
 */
async function searchCommits(
  q: string,
  opts: { repo?: string; limit: number; embedding?: number[] },
): Promise<CommitResult[]> {
  const collection = await getCommitsCollection();
  if (!collection) return [];

  const subQueries = splitQuery(q);
  const queryOpts = { limit: opts.limit, repo: opts.repo };

  let results: VectorResult[];
  if (subQueries.length === 1) {
    results = opts.embedding
      ? await collection.queryCommitsWithEmbedding(opts.embedding, queryOpts)
      : await collection.queryCommits(q, queryOpts);
  } else {
    // Multiple sub-queries need individual embeddings — batch embed then fan out
    const embeddings = await collection.embed(subQueries);
    const batches = await Promise.all(
      embeddings.map((emb, i) => collection.queryCommitsWithEmbedding(emb, queryOpts))
    );

    // Deduplicate by SHA
    const merged = new Map<string, VectorResult>();
    for (const batch of batches) {
      for (const r of batch) {
        const sha = ((r.metadata ?? {}) as Record<string, unknown>).sha as string;
        const key = sha || r.id;
        const existing = merged.get(key);
        if (!existing || r.score > existing.score) {
          merged.set(key, r);
        }
      }
    }

    results = [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit);
  }

  return results.map(r => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      sha: (meta.sha as string) ?? '',
      short_sha: (meta.short_sha as string) ?? '',
      message: (meta.subject as string) ?? '',
      author: (meta.author as string) ?? '',
      date: (meta.date as string) ?? '',
      repo: (meta.repo as string) ?? '',
      score: r.score,
    };
  });
}

/**
 * Search sessions using both fulltext and semantic modes.
 */
async function searchSessions(
  q: string,
  opts: { project?: string; limit: number; excludeSessionId?: string; embedding?: number[] },
): Promise<SessionResult[]> {
  // --- Fulltext (PostgreSQL tsquery) ---
  const fulltextPromise = (async (): Promise<SessionResult[]> => {
    const conditions: string[] = [];
    const params: unknown[] = [q];
    let paramIndex = 2;

    if (opts.project) {
      conditions.push(`(p.handle = $${paramIndex} OR p.name = $${paramIndex})`);
      params.push(opts.project);
      paramIndex++;
    }

    if (opts.excludeSessionId) {
      conditions.push(`s.session_id != $${paramIndex++}`);
      params.push(opts.excludeSessionId);
    }

    const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
    params.push(opts.limit);

    const sql = `
      SELECT
        s.session_id,
        a.handle as assistant_handle,
        p.handle as project_handle,
        s.name,
        s.summary,
        sc.chunk_index,
        ts_headline('english', sc.content, plainto_tsquery('english', $1),
          'MaxWords=50, MinWords=15, StartSel=<<, StopSel=>>') as excerpt,
        ts_rank(to_tsvector('english', sc.content), plainto_tsquery('english', $1)) as rank
      FROM session_chunks sc
      JOIN sessions s ON s.id = sc.session_id
      JOIN assistants a ON a.id = s.assistant_id
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE to_tsvector('english', sc.content) @@ plainto_tsquery('english', $1)
      ${whereClause}
      ORDER BY rank DESC
      LIMIT $${paramIndex}
    `;

    const rows = await pool.query(sql, params);
    return rows.rows.map((r: any) => ({
      session_id: r.session_id,
      assistant_handle: r.assistant_handle,
      project_handle: r.project_handle,
      name: r.name,
      excerpt: r.excerpt,
      rank: parseFloat(r.rank) || 0,
      mode: 'fulltext' as const,
    }));
  })();

  // --- Semantic (vector) ---
  const semanticPromise = (async (): Promise<SessionResult[]> => {
    const collection = await getSessionsCollection();
    const filter: Record<string, unknown> = {};
    if (opts.project) filter.project_dir = opts.project;

    const queryLimit = opts.excludeSessionId ? opts.limit + 5 : opts.limit;
    const vecOpts = {
      limit: queryLimit,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    };
    const results = opts.embedding
      ? await collection.queryWithEmbedding(opts.embedding, vecOpts)
      : await collection.query(q, vecOpts);

    const mapped = results.map(r => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      return {
        session_id: (meta.session_id as string) ?? '',
        assistant_handle: (meta.assistant_handle as string) ?? '',
        project_handle: (meta.project_dir as string) ?? null,
        name: (meta.summary as string) ?? null,
        excerpt: r.content.slice(0, 300),
        rank: r.score,
        mode: 'semantic' as const,
      };
    });

    if (opts.excludeSessionId) {
      return mapped.filter(r => r.session_id !== opts.excludeSessionId).slice(0, opts.limit);
    }
    return mapped;
  })();

  const [fulltextResults, semanticResults] = await Promise.all([fulltextPromise, semanticPromise]);

  // Merge: deduplicate by session_id, keep highest rank
  const merged = new Map<string, SessionResult>();
  for (const r of [...fulltextResults, ...semanticResults]) {
    const key = `${r.session_id}:${r.mode}`;
    const existing = merged.get(key);
    if (!existing || r.rank > existing.rank) {
      merged.set(key, r);
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.rank - a.rank)
    .slice(0, opts.limit);
}

/**
 * Search docs with query splitting.
 */
async function searchDocs(
  q: string,
  opts: { project?: string; limit: number; embedding?: number[] },
): Promise<DocResult[]> {
  const collection = await getOrCreateDocsCollection();

  const filter: Record<string, unknown> = {};
  if (opts.project) filter.project_handle = opts.project;

  const queryOpts = {
    limit: opts.limit * 2,
    filter: Object.keys(filter).length > 0 ? filter : undefined,
  };

  const subQueries = splitQuery(q);
  let allResults: VectorResult[];

  if (subQueries.length === 1) {
    allResults = opts.embedding
      ? await collection.queryWithEmbedding(opts.embedding, queryOpts)
      : await collection.query(q, queryOpts);
  } else {
    // Multiple sub-queries need individual embeddings — batch embed then fan out
    const embeddings = await collection.embed(subQueries);
    const batches = await Promise.all(
      embeddings.map(emb => collection.queryWithEmbedding(emb, queryOpts))
    );
    allResults = batches.flat();
  }

  // Deduplicate by filePath
  const byDoc = new Map<string, { score: number; result: VectorResult }>();
  for (const r of allResults) {
    const key = r.filePath || r.id;
    const existing = byDoc.get(key);
    if (!existing || r.score > existing.score) {
      byDoc.set(key, { score: r.score, result: r });
    }
  }

  return [...byDoc.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit)
    .map(d => {
      const meta = (d.result.metadata ?? {}) as Record<string, unknown>;
      return {
        file_path: d.result.filePath,
        title: (meta.title as string) ?? null,
        content: d.result.content,
        score: d.score,
        file_type: (meta.file_type as string) ?? null,
        project_handle: (meta.project_handle as string) ?? null,
      };
    });
}

/**
 * Search Slack messages (semantic only).
 */
async function searchSlack(
  q: string,
  opts: { channel?: string; limit: number; embedding?: number[] },
): Promise<SlackResult[]> {
  const collection = await getOrCreateSlackCollection();

  const filter: Record<string, unknown> = {};
  if (opts.channel) filter.channel = opts.channel;

  const vecOpts = {
    limit: opts.limit,
    filter: Object.keys(filter).length > 0 ? filter : undefined,
  };
  const results = opts.embedding
    ? await collection.queryWithEmbedding(opts.embedding, vecOpts)
    : await collection.query(q, vecOpts);

  return results.map(r => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      content: r.content,
      score: r.score,
      document_id: r.filePath,
      channel: (meta.channel as string) ?? undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const unifiedSearch: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/search
   * Unified search across all backends.
   */
  fastify.get<{
    Querystring: {
      q: string;
      project?: string;
      repo?: string;
      limit?: number | string;
      backends?: string; // comma-separated: memories,source,commits,sessions,docs,slack
      exclude_session_id?: string;
    };
  }>('/', async (request, reply) => {
    const { q, project, repo, exclude_session_id } = request.query;
    const limit = typeof request.query.limit === 'string'
      ? parseInt(request.query.limit, 10)
      : (request.query.limit ?? 10);

    if (!q || q.trim().length < 2) {
      return reply.status(400).send({ error: 'q is required (minimum 2 characters)' });
    }

    const requestedBackends = request.query.backends
      ? new Set(request.query.backends.split(',').map(b => b.trim()))
      : new Set(['memories', 'source', 'commits', 'sessions', 'docs', 'slack']);

    const start = Date.now();
    const errors: string[] = [];
    const activeBackends: string[] = [];

    // Determine which backends need vector search — embed query once for all of them
    const needsVector = ['memories', 'source', 'commits', 'sessions', 'docs', 'slack']
      .some(b => requestedBackends.has(b));

    let embedding: number[] | undefined;
    if (needsVector) {
      try {
        const kvec = getKvec();
        const [emb] = await kvec.getEmbedder().embed([q]);
        embedding = emb;
      } catch (err: any) {
        errors.push(`embed: ${err.message}`);
        // Continue without embedding — keyword/fulltext backends still work
      }
    }

    // Build parallel search promises
    const promises: Record<string, Promise<unknown>> = {};

    if (requestedBackends.has('memories')) {
      activeBackends.push('memories');
      promises.memories = searchMemories(q, { project_id: project, limit, embedding })
        .catch(err => { errors.push(`memories: ${err.message}`); return []; });
    }

    if (requestedBackends.has('source')) {
      activeBackends.push('source_code');
      promises.source_code = searchSourceCode(q, { repo, limit, embedding })
        .catch(err => { errors.push(`source: ${err.message}`); return []; });
    }

    if (requestedBackends.has('commits')) {
      activeBackends.push('commits');
      promises.commits = searchCommits(q, { repo, limit, embedding })
        .catch(err => { errors.push(`commits: ${err.message}`); return []; });
    }

    if (requestedBackends.has('sessions')) {
      activeBackends.push('sessions');
      promises.sessions = searchSessions(q, { project, limit, excludeSessionId: exclude_session_id, embedding })
        .catch(err => { errors.push(`sessions: ${err.message}`); return []; });
    }

    if (requestedBackends.has('docs')) {
      activeBackends.push('docs');
      promises.docs = searchDocs(q, { project, limit, embedding })
        .catch(err => { errors.push(`docs: ${err.message}`); return []; });
    }

    if (requestedBackends.has('slack')) {
      activeBackends.push('slack');
      promises.slack = searchSlack(q, { limit, embedding })
        .catch(err => { errors.push(`slack: ${err.message}`); return []; });
    }

    // Execute all in parallel
    const keys = Object.keys(promises);
    const values = await Promise.all(Object.values(promises));
    const results: Record<string, unknown> = {};
    keys.forEach((key, i) => { results[key] = values[i]; });

    const duration = Date.now() - start;

    const response: UnifiedSearchResult = {
      memories: (results.memories as MemoryResult[]) ?? [],
      source_code: (results.source_code as SourceResult[]) ?? [],
      commits: (results.commits as CommitResult[]) ?? [],
      sessions: (results.sessions as SessionResult[]) ?? [],
      docs: (results.docs as DocResult[]) ?? [],
      slack: (results.slack as SlackResult[]) ?? [],
      meta: {
        query: q,
        duration_ms: duration,
        backends: activeBackends,
        errors,
      },
    };

    return response;
  });
};

export default unifiedSearch;
