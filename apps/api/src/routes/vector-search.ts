/**
 * Semantic search route using kvec vector embeddings.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { VectorResult, Collection } from '@khef/kvec';
import { spawn } from 'child_process';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import pool, { querySingle } from '../db/client';
import { getMemoriesCollection, getSourceCollection, getCommitsCollection, getOrCreateDocsCollection } from '../services/kvec-service';
import { sanitizeRef } from '../services/git';

// ---------------------------------------------------------------------------
// Query auto-splitting for long semantic searches
// ---------------------------------------------------------------------------

const MAX_BIGRAMS = 5;

/**
 * Split a query with 4+ terms into overlapping bigrams so each sub-query
 * hits a tighter region of embedding space. Queries with <= 3 terms pass
 * through unchanged.
 */
function splitQuery(q: string): string[] {
  const terms = q.trim().split(/\s+/);
  if (terms.length <= 3) return [q];

  const bigrams: string[] = [];
  for (let i = 0; i < terms.length - 1; i++) {
    bigrams.push(terms.slice(i, i + 2).join(' '));
  }

  if (bigrams.length <= MAX_BIGRAMS) return bigrams;

  // Evenly sample from the bigram list to stay within the cap
  const stride = (bigrams.length - 1) / (MAX_BIGRAMS - 1);
  return Array.from({ length: MAX_BIGRAMS }, (_, i) =>
    bigrams[Math.round(i * stride)]
  );
}

/**
 * Run a query (possibly auto-split) against a source collection and merge
 * results. Deduplicates by filePath:chunkIndex, keeping the max score.
 */
async function multiQuerySource(
  collection: Collection,
  q: string,
  opts: Parameters<Collection['query']>[1],
): Promise<VectorResult[]> {
  const dedupeResults = (rows: VectorResult[]): VectorResult[] => {
    const merged = new Map<string, VectorResult>();
    for (const r of rows) {
      const key = `${r.filePath}:${r.chunkIndex}`;
      const existing = merged.get(key);
      if (!existing || r.score > existing.score) {
        merged.set(key, r);
      }
    }

    return [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, opts?.limit ?? 10);
  };

  const subQueries = splitQuery(q);

  if (subQueries.length === 1) {
    const rows = await collection.query(q, opts);
    return dedupeResults(rows);
  }

  const batches = await Promise.all(
    subQueries.map((sq) => collection.query(sq, opts))
  );

  return dedupeResults(batches.flat());
}

/**
 * Run a query (possibly auto-split) against a commits collection and merge
 * results. Deduplicates by SHA, keeping the max score.
 */
async function multiQueryCommits(
  collection: Collection,
  q: string,
  opts: Parameters<Collection['queryCommits']>[1],
): Promise<VectorResult[]> {
  const subQueries = splitQuery(q);

  if (subQueries.length === 1) {
    return collection.queryCommits(q, opts);
  }

  const batches = await Promise.all(
    subQueries.map((sq) => collection.queryCommits(sq, opts))
  );

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

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, opts?.limit ?? 20);
}

interface SearchQuery {
  q: string;
  project_id?: string;
  type?: string;
  limit?: number | string;
  compact?: boolean | string;
}

interface MemoryRow {
  id: string;
  project_id: string;
  handle: string;
  title: string;
  content: string;
  type: string;
  status: string;
  updated_at: Date;
  project_handle: string;
  project_name: string;
}

interface SourceResultMetadataRow {
  file_path: string;
  chunk_index: number;
  repo_name: string | null;
  branch: string | null;
  commit_hash: string | null;
}

interface StringValueRow {
  value: string;
}

const vectorSearch: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/vector/search
   * Semantic search using vector embeddings.
   */
  fastify.get<{ Querystring: SearchQuery }>('/search', async (request, reply) => {
    const { q, project_id, type } = request.query;
    const limit = typeof request.query.limit === 'string'
      ? parseInt(request.query.limit, 10)
      : (request.query.limit ?? 10);
    const compact = request.query.compact === 'false' ? false : true;

    if (!q) {
      return reply.status(400).send({ error: 'q (query) is required' });
    }

    // Build metadata filter
    const filter: Record<string, unknown> = {};
    if (project_id) filter.project_id = project_id;
    if (type) filter.type = type;

    // Query kvec — handles embedding generation internally
    const collection = await getMemoriesCollection();
    const vectorResults = await collection.query(q, {
      limit,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    });

    if (vectorResults.length === 0) {
      return {
        memories: [],
        pagination: { total_count: 0, limit, offset: 0, has_more: false },
      };
    }

    // Deduplicate by memory_id (take highest score per memory)
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

    if (memoryIds.length === 0) {
      return {
        memories: [],
        pagination: { total_count: 0, limit, offset: 0, has_more: false },
      };
    }

    // Fetch memories from PostgreSQL
    const memoriesResult = await pool.query<MemoryRow>(`
      SELECT
        m.id,
        m.project_id,
        m.handle,
        m.title,
        m.content,
        mt.name as type,
        mts.status_value as status,
        m.updated_at,
        p.handle as project_handle,
        p.name as project_name
      FROM memories m
      JOIN memory_types mt ON mt.id = m.memory_type_id
      JOIN memory_type_statuses mts ON mts.id = m.status_id
      JOIN projects p ON p.id = m.project_id
      WHERE m.id = ANY($1::uuid[])
    `, [memoryIds]);

    // Build response with scores
    const memoriesById = new Map(memoriesResult.rows.map(m => [m.id, m]));
    const memories = memoryIds
      .map(id => {
        const memory = memoriesById.get(id);
        if (!memory) return null;

        const score = memoryScores.get(id) || 0;

        if (compact) {
          return {
            id: memory.id,
            project_id: memory.project_id,
            project_handle: memory.project_handle,
            project_name: memory.project_name,
            handle: memory.handle,
            title: memory.title,
            type: memory.type,
            status: memory.status,
            updated_at: memory.updated_at,
            content_excerpt: memory.content.slice(0, 200) + (memory.content.length > 200 ? '...' : ''),
            semantic_score: score,
          };
        }

        return {
          id: memory.id,
          project_id: memory.project_id,
          project_handle: memory.project_handle,
          project_name: memory.project_name,
          handle: memory.handle,
          title: memory.title,
          content: memory.content,
          type: memory.type,
          status: memory.status,
          updated_at: memory.updated_at,
          semantic_score: score,
        };
      })
      .filter(Boolean);

    return {
      memories,
      pagination: {
        total_count: memories.length,
        limit,
        offset: 0,
        has_more: false,
      },
    };
  });

  /**
   * GET /api/vector/source/search
   * Semantic search across indexed source code files.
   */
  fastify.get<{
    Querystring: {
      q: string;
      language?: string;
      repo?: string;
      branch?: string;
      commit?: string;
      limit?: number | string;
      min_score?: number | string;
      context?: number | string;
    };
  }>('/source/search', async (request, reply) => {
    const { q, language, repo, branch, commit } = request.query;
    const limit = typeof request.query.limit === 'string'
      ? parseInt(request.query.limit, 10)
      : (request.query.limit ?? 10);
    const minScore = typeof request.query.min_score === 'string'
      ? parseFloat(request.query.min_score)
      : (request.query.min_score ?? 0);
    const contextN = Math.min(
      Math.max(0, Math.floor(
        typeof request.query.context === 'string'
          ? parseInt(request.query.context, 10)
          : (request.query.context ?? 1)
      )),
      3 // cap at 3 neighboring chunks
    );

    if (!q) {
      return reply.status(400).send({ error: 'q (query) is required' });
    }

    const collection = await getSourceCollection();
    if (!collection) {
      return reply.status(404).send({ error: 'kvec-source collection not found. Run the ingest script first.' });
    }

    const queryOpts = {
      limit,
      repoName: repo,
      language,
      branch,
      commitHash: commit,
      minScore: minScore > 0 ? minScore : undefined,
    };

    const results = await multiQuerySource(collection, q, queryOpts);

    // `@khef/kvec` source-code queries may return null chunk metadata.
    // Backfill repo/branch/commit by joining kvec tables on file_path + chunk_index
    // so the UI can build source filters (repo/language/branch) reliably.
    const sourceMetaByKey = new Map<string, SourceResultMetadataRow>();
    if (results.length > 0) {
      const filePaths = results.map((r) => r.filePath);
      const chunkIndexes = results.map((r) => r.chunkIndex);
      const metaRows = await pool.query<SourceResultMetadataRow>(`
        SELECT
          q.file_path,
          q.chunk_index,
          md.repo_name,
          md.branch,
          md.commit_hash
        FROM UNNEST($1::text[], $2::int[]) AS q(file_path, chunk_index)
        LEFT JOIN LATERAL (
          SELECT
            r.name AS repo_name,
            s.branch,
            s.commit_hash
          FROM kvec.tracked_files tf
          JOIN kvec.chunks ch
            ON ch.file_id = tf.id
           AND ch.chunk_index = q.chunk_index
          JOIN kvec.collections c
            ON c.id = tf.collection_id
          LEFT JOIN kvec.repos r
            ON r.id = tf.repo_id
          LEFT JOIN kvec.snapshot_files sf
            ON sf.file_id = tf.id
          LEFT JOIN kvec.snapshots s
            ON s.id = sf.snapshot_id
          WHERE c.name = 'kvec-source'
            AND tf.file_path = q.file_path
            AND ($3::text IS NULL OR s.branch = $3)
            AND ($4::text IS NULL OR s.commit_hash = $4)
          ORDER BY s.created_at DESC NULLS LAST
          LIMIT 1
        ) AS md ON TRUE
      `, [filePaths, chunkIndexes, branch ?? null, commit ?? null]);

      for (const row of metaRows.rows) {
        sourceMetaByKey.set(`${row.file_path}:${row.chunk_index}`, row);
      }
    }

    const mappedResults = results.map((r) => {
      const key = `${r.filePath}:${r.chunkIndex}`;
      const joined = sourceMetaByKey.get(key);
      const metadata = { ...((r.metadata ?? {}) as Record<string, unknown>) };

      if (joined?.repo_name) {
        if (metadata.repoName == null) metadata.repoName = joined.repo_name;
        if (metadata.repo == null) metadata.repo = joined.repo_name;
      }
      if (joined?.branch && metadata.branch == null) metadata.branch = joined.branch;
      if (joined?.commit_hash) {
        if (metadata.commitHash == null) metadata.commitHash = joined.commit_hash;
        if (metadata.commit == null) metadata.commit = joined.commit_hash;
      }

      return {
        file_path: r.filePath,
        content: r.content,
        score: r.score,
        language: r.language,
        chunk_index: r.chunkIndex,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
      };
    });

    // Fetch neighboring chunks when context > 0
    if (contextN > 0 && mappedResults.length > 0) {
      const fileIds = results.map((r) => r.fileId);
      const chunkIdxs = results.map((r) => r.chunkIndex);

      const neighborRows = await pool.query<{
        file_id: string;
        chunk_index: number;
        content: string;
      }>(`
        SELECT DISTINCT c.file_id, c.chunk_index, c.content
        FROM UNNEST($1::uuid[], $2::int[]) AS q(file_id, chunk_idx)
        JOIN kvec.chunks c
          ON c.file_id = q.file_id
         AND c.chunk_index BETWEEN q.chunk_idx - $3 AND q.chunk_idx + $3
         AND c.chunk_index <> q.chunk_idx
        ORDER BY c.file_id, c.chunk_index
      `, [fileIds, chunkIdxs, contextN]);

      // Build lookup: fileId -> Map<chunkIndex, content>
      const neighborMap = new Map<string, Map<number, string>>();
      for (const row of neighborRows.rows) {
        if (!neighborMap.has(row.file_id)) neighborMap.set(row.file_id, new Map());
        neighborMap.get(row.file_id)!.set(row.chunk_index, row.content);
      }

      for (let i = 0; i < mappedResults.length; i++) {
        const r = mappedResults[i];
        const fileId = results[i].fileId;
        const idx = results[i].chunkIndex;
        const fileNeighbors = neighborMap.get(fileId);

        const before: { chunk_index: number; content: string }[] = [];
        const after: { chunk_index: number; content: string }[] = [];

        if (fileNeighbors) {
          for (let d = contextN; d >= 1; d--) {
            const content = fileNeighbors.get(idx - d);
            if (content !== undefined) before.push({ chunk_index: idx - d, content });
          }
          for (let d = 1; d <= contextN; d++) {
            const content = fileNeighbors.get(idx + d);
            if (content !== undefined) after.push({ chunk_index: idx + d, content });
          }
        }

        (r as any).context_before = before;
        (r as any).context_after = after;
      }
    }

    return {
      results: mappedResults,
      total_count: results.length,
    };
  });

  /**
   * GET /api/vector/source/facets
   * List available source-code filter values (repos/languages/branches) for kvec-source.
   */
  fastify.get<{ Querystring: { repo?: string } }>('/source/facets', async (request, reply) => {
    const { repo } = request.query;
    const sourceCollection = await getSourceCollection();
    if (!sourceCollection) {
      return reply.status(404).send({ error: 'kvec-source collection not found. Run the ingest script first.' });
    }

    const [repoRows, languageRows, branchRows] = await Promise.all([
      pool.query<StringValueRow>(`
        SELECT DISTINCT r.name AS value
        FROM kvec.tracked_files tf
        JOIN kvec.collections c ON c.id = tf.collection_id
        JOIN kvec.repos r ON r.id = tf.repo_id
        WHERE c.name = 'kvec-source'
          AND tf.status = 'active'
          AND r.name IS NOT NULL
          AND r.name <> ''
        ORDER BY r.name ASC
      `),
      pool.query<StringValueRow>(`
        SELECT DISTINCT tf.language AS value
        FROM kvec.tracked_files tf
        JOIN kvec.collections c ON c.id = tf.collection_id
        LEFT JOIN kvec.repos r ON r.id = tf.repo_id
        WHERE c.name = 'kvec-source'
          AND tf.status = 'active'
          AND ($1::text IS NULL OR r.name = $1)
          AND tf.language IS NOT NULL
          AND tf.language <> ''
        ORDER BY tf.language ASC
      `, [repo ?? null]),
      pool.query<StringValueRow>(`
        SELECT DISTINCT s.branch AS value
        FROM kvec.tracked_files tf
        JOIN kvec.collections c ON c.id = tf.collection_id
        LEFT JOIN kvec.repos r ON r.id = tf.repo_id
        JOIN kvec.snapshot_files sf ON sf.file_id = tf.id
        JOIN kvec.snapshots s ON s.id = sf.snapshot_id
        WHERE c.name = 'kvec-source'
          AND tf.status = 'active'
          AND ($1::text IS NULL OR r.name = $1)
          AND s.branch IS NOT NULL
          AND s.branch <> ''
        ORDER BY s.branch ASC
      `, [repo ?? null]),
    ]);

    return {
      repos: repoRows.rows.map((r) => r.value),
      languages: languageRows.rows.map((r) => r.value),
      branches: branchRows.rows.map((r) => r.value),
    };
  });
  /**
   * GET /api/vector/commits/search
   * Semantic search across indexed git commit messages.
   */
  fastify.get<{
    Querystring: {
      q: string;
      repo?: string;
      author?: string;
      since?: string;
      until?: string;
      branch?: string;
      limit?: number | string;
      offset?: number | string;
      min_score?: number | string;
    };
  }>('/commits/search', async (request, reply) => {
    const { q, repo, author, since, until, branch } = request.query;
    const limit = typeof request.query.limit === 'string'
      ? parseInt(request.query.limit, 10)
      : (request.query.limit ?? 20);
    const offset = typeof request.query.offset === 'string'
      ? parseInt(request.query.offset, 10)
      : (request.query.offset ?? 0);
    const minScore = typeof request.query.min_score === 'string'
      ? parseFloat(request.query.min_score)
      : (request.query.min_score ?? 0);

    if (!q) {
      return reply.status(400).send({ error: 'q (query) is required' });
    }

    const collection = await getCommitsCollection();
    if (!collection) {
      return reply.status(404).send({ error: 'kvec-commits collection not found. Run a commit embed job first.' });
    }

    // Fetch more than needed for offset pagination
    const fetchLimit = limit + offset;
    const results = await multiQueryCommits(collection, q, {
      limit: fetchLimit,
      repo,
      author,
      branch,
      since,
      until,
      minScore: minScore > 0 ? minScore : undefined,
    });

    const mapped = results.map((r: VectorResult) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      return {
        sha: (meta.sha as string) ?? '',
        short_sha: (meta.short_sha as string) ?? '',
        message: (meta.subject as string) ?? '',
        author: (meta.author as string) ?? '',
        date: (meta.date as string) ?? '',
        repo: (meta.repo as string) ?? '',
        score: r.score,
        content: r.content,
      };
    });

    const totalCount = mapped.length;
    const paged = mapped.slice(offset, offset + limit);

    return {
      results: paged,
      pagination: {
        total_count: totalCount,
        limit,
        offset,
        has_more: offset + limit < totalCount,
      },
    };
  });

  /**
   * GET /api/vector/docs/search
   * Semantic search across indexed documents (markdown, PDF, text).
   */
  fastify.get<{
    Querystring: {
      q: string;
      project?: string;
      tag?: string;
      file_type?: string;
      limit?: number | string;
      min_score?: number | string;
    };
  }>('/docs/search', async (request, reply) => {
    const { q, project, tag, file_type } = request.query;
    const limit = typeof request.query.limit === 'string'
      ? parseInt(request.query.limit, 10)
      : (request.query.limit ?? 10);
    const minScore = typeof request.query.min_score === 'string'
      ? parseFloat(request.query.min_score)
      : (request.query.min_score ?? 0);

    if (!q) {
      return reply.status(400).send({ error: 'q (query) is required' });
    }

    const collection = await getOrCreateDocsCollection();

    // Build metadata filter for JSONB containment
    const filter: Record<string, unknown> = {};
    if (project) filter.project_handle = project;
    if (file_type) filter.file_type = file_type;

    const queryOpts: Parameters<Collection['query']>[1] = {
      limit: limit * 2, // over-fetch for dedup
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      minScore: minScore > 0 ? minScore : undefined,
    };

    const subQueries = splitQuery(q);
    let allResults: VectorResult[];

    if (subQueries.length === 1) {
      allResults = await collection.query(q, queryOpts);
    } else {
      const batches = await Promise.all(
        subQueries.map((sq) => collection.query(sq, queryOpts))
      );
      allResults = batches.flat();
    }

    // Deduplicate by filePath, keeping max score per document
    const byDoc = new Map<string, { score: number; result: VectorResult }>();
    for (const r of allResults) {
      const key = r.filePath || r.id;
      const existing = byDoc.get(key);
      if (!existing || r.score > existing.score) {
        byDoc.set(key, { score: r.score, result: r });
      }
    }

    // Filter by tag if specified (tag is in metadata.tags array)
    let docEntries = [...byDoc.values()];
    if (tag) {
      docEntries = docEntries.filter((d) => {
        const meta = (d.result.metadata ?? {}) as Record<string, unknown>;
        const tags = meta.tags as string[] | undefined;
        return tags?.includes(tag);
      });
    }

    const sorted = docEntries
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const results = sorted.map((d) => {
      const meta = (d.result.metadata ?? {}) as Record<string, unknown>;
      return {
        file_path: d.result.filePath,
        title: (meta.title as string) ?? null,
        content: d.result.content,
        score: d.score,
        file_type: (meta.file_type as string) ?? null,
        project_handle: (meta.project_handle as string) ?? null,
        tags: (meta.tags as string[]) ?? [],
        source_path: (meta.source_path as string) ?? null,
      };
    });

    return {
      results,
      total_count: results.length,
    };
  });

  /**
   * GET /api/vector/docs/:documentId/content
   * Retrieve paginated chunks of an indexed document by its file path (document ID).
   * The documentId is the file_path used during ingestion (URL-encoded in the path).
   */
  fastify.get<{
    Params: { documentId: string };
    Querystring: {
      limit?: number | string;
      offset?: number | string;
    };
  }>('/docs/:documentId/content', async (request, reply) => {
    const documentId = decodeURIComponent(request.params.documentId);
    const limit = typeof request.query.limit === 'string'
      ? parseInt(request.query.limit, 10)
      : (request.query.limit ?? 10);
    const offset = typeof request.query.offset === 'string'
      ? parseInt(request.query.offset, 10)
      : (request.query.offset ?? 0);

    // Find the tracked file
    const file = await pool.query<{
      id: string;
      file_path: string;
      metadata: Record<string, unknown> | null;
    }>(`
      SELECT tf.id, tf.file_path, tf.metadata
      FROM kvec.tracked_files tf
      JOIN kvec.collections c ON c.id = tf.collection_id
      WHERE c.name = 'kvec-docs'
        AND tf.file_path = $1
      LIMIT 1
    `, [documentId]);

    if (file.rows.length === 0) {
      return reply.status(404).send({ error: 'Document not found in kvec-docs collection' });
    }

    const trackedFile = file.rows[0];

    // Get total chunk count
    const countResult = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM kvec.chunks
      WHERE file_id = $1
    `, [trackedFile.id]);
    const totalChunks = parseInt(countResult.rows[0]?.count || '0', 10);

    // Fetch chunks with pagination
    const chunks = await pool.query<{
      chunk_index: number;
      content: string;
      token_count: number | null;
      chunk_method: string | null;
    }>(`
      SELECT chunk_index, content, token_count, chunk_method
      FROM kvec.chunks
      WHERE file_id = $1
      ORDER BY chunk_index ASC
      LIMIT $2 OFFSET $3
    `, [trackedFile.id, limit, offset]);

    const meta = trackedFile.metadata || {};

    return {
      document_id: documentId,
      title: (meta.title as string) ?? null,
      file_type: (meta.file_type as string) ?? null,
      project_handle: (meta.project_handle as string) ?? null,
      tags: (meta.tags as string[]) ?? [],
      source_path: (meta.source_path as string) ?? null,
      chunks: chunks.rows.map((c) => ({
        chunk_index: c.chunk_index,
        content: c.content,
        token_count: c.token_count,
        chunk_method: c.chunk_method,
      })),
      pagination: {
        total_chunks: totalChunks,
        limit,
        offset,
        has_more: offset + limit < totalChunks,
      },
    };
  });

  /**
   * GET /api/vector/docs/facets
   * List available filter values for the kvec-docs collection.
   */
  fastify.get('/docs/facets', async () => {
    const [projectRows, fileTypeRows, tagRows] = await Promise.all([
      pool.query<StringValueRow>(`
        SELECT DISTINCT metadata->>'project_handle' AS value
        FROM kvec.tracked_files
        WHERE collection_id = (SELECT id FROM kvec.collections WHERE name = 'kvec-docs')
          AND metadata->>'project_handle' IS NOT NULL
          AND metadata->>'project_handle' <> ''
        ORDER BY value ASC
      `),
      pool.query<StringValueRow>(`
        SELECT DISTINCT metadata->>'file_type' AS value
        FROM kvec.tracked_files
        WHERE collection_id = (SELECT id FROM kvec.collections WHERE name = 'kvec-docs')
          AND metadata->>'file_type' IS NOT NULL
          AND metadata->>'file_type' <> ''
        ORDER BY value ASC
      `),
      pool.query<StringValueRow>(`
        SELECT DISTINCT jsonb_array_elements_text(metadata->'tags') AS value
        FROM kvec.tracked_files
        WHERE collection_id = (SELECT id FROM kvec.collections WHERE name = 'kvec-docs')
          AND metadata->'tags' IS NOT NULL
          AND jsonb_typeof(metadata->'tags') = 'array'
        ORDER BY value ASC
      `),
    ]);

    return {
      projects: projectRows.rows.map((r) => r.value),
      file_types: fileTypeRows.rows.map((r) => r.value),
      tags: tagRows.rows.map((r) => r.value),
    };
  });

  /**
   * GET /api/vector/source/file
   * View a source file, either:
   *   - by `repo` + repo-relative `path` (kvec-indexed), or
   *   - by `abs_path` (absolute path, must resolve inside $HOME; leading `~` expanded).
   * Optional 1-based start/end line slice and optional git ref. If ref is given,
   * reads via `git show <ref>:<relpath>` against the repo root without touching
   * the working tree. Otherwise reads from disk.
   */
  fastify.get<{
    Querystring: {
      repo?: string;
      path?: string;
      abs_path?: string;
      start?: number | string;
      end?: number | string;
      ref?: string;
    };
  }>('/source/file', async (request, reply) => {
    const { repo, path: filePath, abs_path: absPathInput, ref } = request.query;

    const hasAbsMode = !!absPathInput;
    const hasRepoMode = !!repo || !!filePath;

    if (hasAbsMode && hasRepoMode) {
      return reply.status(400).send({ error: 'provide either abs_path, or repo+path — not both' });
    }
    if (!hasAbsMode && !hasRepoMode) {
      return reply.status(400).send({ error: 'abs_path is required, or both repo and path' });
    }
    if (hasRepoMode && (!repo || !filePath)) {
      return reply.status(400).send({ error: 'repo and path are required together' });
    }
    if (hasRepoMode && filePath && (filePath.startsWith('/') || filePath.includes('..'))) {
      return reply.status(400).send({ error: 'path must be repo-relative and not contain ".."' });
    }

    const parseLine = (v: unknown): number | undefined => {
      if (v === undefined || v === '') return undefined;
      const n = typeof v === 'string' ? parseInt(v, 10) : (v as number);
      return Number.isFinite(n) ? n : NaN;
    };
    const start = parseLine(request.query.start);
    const end = parseLine(request.query.end);

    if (start !== undefined && (Number.isNaN(start) || start < 1)) {
      return reply.status(400).send({ error: 'start must be a positive integer (1-based)' });
    }
    if (end !== undefined && (Number.isNaN(end) || end < 1)) {
      return reply.status(400).send({ error: 'end must be a positive integer (1-based)' });
    }
    if (start !== undefined && end !== undefined && start > end) {
      return reply.status(400).send({ error: 'start must be <= end' });
    }

    // Resolve absolute path to read from disk, plus optional git-root + relative
    // path for `ref` mode.
    let diskAbsPath: string;
    let gitRootPath: string | null = null;
    let gitRelPath: string | null = null;
    let responseRepo: string | null = null;
    let responsePath: string;
    let responseRootPath: string | null = null;

    if (hasAbsMode) {
      const home = os.homedir();
      const raw = absPathInput!;
      const expanded = raw === '~'
        ? home
        : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;

      if (!path.isAbsolute(expanded)) {
        return reply.status(400).send({ error: 'abs_path must be absolute (or start with ~)' });
      }

      const resolved = path.resolve(expanded);
      if (resolved !== home && !resolved.startsWith(home + path.sep)) {
        return reply.status(400).send({ error: 'abs_path must resolve within $HOME' });
      }

      diskAbsPath = resolved;
      responsePath = resolved;

      if (ref) {
        try {
          const startDir = path.dirname(resolved);
          gitRootPath = await new Promise<string>((resolve2, reject2) => {
            const proc = spawn('git', ['rev-parse', '--show-toplevel'], { cwd: startDir });
            let out = '';
            let err = '';
            proc.stdout.on('data', (d) => { out += d.toString(); });
            proc.stderr.on('data', (d) => { err += d.toString(); });
            proc.on('close', (code) => {
              if (code === 0) resolve2(out.trim());
              else reject2(new Error(err.trim() || `git rev-parse exited with code ${code}`));
            });
            proc.on('error', (e) => reject2(e));
          });
        } catch (e: any) {
          return reply.status(400).send({ error: `Cannot locate git repo root for ref mode: ${e?.message || e}` });
        }
        gitRelPath = path.relative(gitRootPath, resolved);
        responseRootPath = gitRootPath;
      }
    } else {
      const repoRow = await querySingle<{ root_path: string }>(
        `SELECT r.root_path
         FROM kvec.repos r
         JOIN kvec.collections c ON c.id = r.collection_id
         WHERE c.name = 'kvec-source' AND r.name = $1
         LIMIT 1`,
        [repo!]
      );
      if (!repoRow) {
        return reply.status(404).send({ error: `Repo not found in kvec-source: ${repo}` });
      }

      const rootPath = path.resolve(repoRow.root_path);
      const absPath = path.resolve(rootPath, filePath!);
      if (absPath !== rootPath && !absPath.startsWith(rootPath + path.sep)) {
        return reply.status(400).send({ error: 'path escapes repo root' });
      }

      diskAbsPath = absPath;
      gitRootPath = rootPath;
      gitRelPath = filePath!;
      responseRepo = repo!;
      responsePath = filePath!;
      responseRootPath = rootPath;
    }

    let content: string;
    try {
      if (ref) {
        const safeRef = sanitizeRef(ref);
        content = await new Promise<string>((resolve, rejectP) => {
          const proc = spawn('git', ['show', `${safeRef}:${gitRelPath}`], { cwd: gitRootPath! });
          let stdout = '';
          let stderr = '';
          proc.stdout.on('data', (d) => { stdout += d.toString(); });
          proc.stderr.on('data', (d) => { stderr += d.toString(); });
          proc.on('close', (code) => {
            if (code === 0) resolve(stdout);
            else rejectP(new Error(stderr.trim() || `git show exited with code ${code}`));
          });
          proc.on('error', (err) => rejectP(err));
        });
      } else {
        content = await fsp.readFile(diskAbsPath, 'utf-8');
      }
    } catch (err: any) {
      return reply.status(404).send({ error: err?.message || 'Failed to read file' });
    }

    // Split preserving empty trailing line behavior; join will round-trip faithfully
    const allLines = content.split('\n');
    const totalLines = allLines.length;
    const sliceStart = start ? Math.min(start, totalLines) - 1 : 0;
    const sliceEnd = end ? Math.min(totalLines, end) : totalLines;
    const slicedLines = allLines.slice(sliceStart, sliceEnd);

    return {
      repo: responseRepo,
      path: responsePath,
      ref: ref ?? null,
      root_path: responseRootPath,
      start: sliceStart + 1,
      end: sliceStart + slicedLines.length,
      total_lines: totalLines,
      content: slicedLines.join('\n'),
    };
  });
};

export default vectorSearch;
