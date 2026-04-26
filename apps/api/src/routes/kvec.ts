import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { query, querySingle } from '../db/client';
import {
  startEmbedJob,
  startCommitEmbedJob,
  getJob,
  listJobs,
  cancelJob,
  deleteJob,
  checkEmbedServerHealth,
} from '../services/kvec-embed-worker';
import {
  startDocEmbedJob,
  getDocJob,
  listDocJobs,
  cancelDocJob,
  deleteDocJob,
} from '../services/kvec-doc-worker';

const kvecRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /collections — list all collections with stats
  fastify.get('/collections', async () => {
    const rows = await query(
      `SELECT * FROM kvec.collection_stats ORDER BY created_at DESC`
    );
    return { collections: rows };
  });

  // GET /collections/:name — single collection detail + stats
  fastify.get<{ Params: { name: string } }>('/collections/:name', async (request, reply) => {
    const { name } = request.params;
    const row = await querySingle(
      `SELECT * FROM kvec.collection_stats WHERE name = $1`,
      [name]
    );
    if (!row) {
      return reply.status(404).send({ error: 'Collection not found' });
    }
    return { collection: row };
  });

  // GET /collections/:name/repos — list repos in collection with file counts
  fastify.get<{ Params: { name: string } }>('/collections/:name/repos', async (request, reply) => {
    const { name } = request.params;
    const col = await querySingle<{ id: string }>(
      `SELECT id FROM kvec.collections WHERE name = $1`,
      [name]
    );
    if (!col) {
      return reply.status(404).send({ error: 'Collection not found' });
    }

    const rows = await query(
      `SELECT r.*,
              COUNT(DISTINCT f.id)::int AS file_count,
              COUNT(DISTINCT s.id)::int AS snapshot_count,
              MAX(f.updated_at) AS last_upload
       FROM kvec.repos r
       LEFT JOIN kvec.tracked_files f ON f.repo_id = r.id
       LEFT JOIN kvec.snapshots s ON s.repo_id = r.id
       WHERE r.collection_id = $1
       GROUP BY r.id
       ORDER BY r.name`,
      [col.id]
    );
    return { repos: rows };
  });

  // GET /collections/:name/files — paginated file list with filters
  fastify.get<{
    Params: { name: string };
    Querystring: {
      repo?: string;
      language?: string;
      status?: string;
      q?: string;
      limit?: string;
      offset?: string;
    };
  }>('/collections/:name/files', async (request, reply) => {
    const { name } = request.params;
    const col = await querySingle<{ id: string }>(
      `SELECT id FROM kvec.collections WHERE name = $1`,
      [name]
    );
    if (!col) {
      return reply.status(404).send({ error: 'Collection not found' });
    }

    const limit = Math.min(parseInt(request.query.limit || '50', 10), 200);
    const offset = parseInt(request.query.offset || '0', 10);
    const { repo, language, status, q } = request.query;

    const conditions = ['f.collection_id = $1'];
    const params: any[] = [col.id];
    let paramIdx = 2;

    if (repo) {
      conditions.push(`r.name = $${paramIdx++}`);
      params.push(repo);
    }
    if (language) {
      conditions.push(`f.language = $${paramIdx++}`);
      params.push(language);
    }
    if (status) {
      conditions.push(`f.status = $${paramIdx++}`);
      params.push(status);
    }
    if (q) {
      conditions.push(`f.file_path ILIKE $${paramIdx++}`);
      params.push(`%${q}%`);
    }

    const where = conditions.join(' AND ');

    const countResult = await querySingle<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM kvec.tracked_files_stats f
       LEFT JOIN kvec.repos r ON r.id = f.repo_id
       WHERE ${where}`,
      params
    );
    const totalCount = parseInt(countResult?.count || '0', 10);

    const files = await query(
      `SELECT f.id, f.file_path, f.content_hash, f.file_size, f.language,
              f.status, f.error_message, f.uploaded_at, f.updated_at,
              f.chunk_count, f.total_token_count, f.chunk_methods,
              r.name AS repo_name,
              latest_snap.branch, latest_snap.commit_hash
       FROM kvec.tracked_files_stats f
       LEFT JOIN kvec.repos r ON r.id = f.repo_id
       LEFT JOIN LATERAL (
         SELECT s.branch, s.commit_hash
         FROM kvec.snapshot_files sf
         JOIN kvec.snapshots s ON s.id = sf.snapshot_id
         WHERE sf.file_id = f.id
         ORDER BY s.created_at DESC
         LIMIT 1
       ) latest_snap ON true
       WHERE ${where}
       ORDER BY f.updated_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset]
    );

    return {
      files,
      pagination: {
        total_count: totalCount,
        limit,
        offset,
        has_more: offset + limit < totalCount,
      },
    };
  });

  // DELETE /collections/:name/files — delete all tracked files + chunks in a collection
  fastify.delete<{ Params: { name: string } }>(
    '/collections/:name/files',
    async (request, reply) => {
      const { name } = request.params;
      const col = await querySingle<{ id: string }>(
        `SELECT id FROM kvec.collections WHERE name = $1`,
        [name]
      );
      if (!col) {
        return reply.status(404).send({ error: 'Collection not found' });
      }

      const result = await querySingle<{ count: number }>(
        `WITH deleted AS (
           DELETE FROM kvec.tracked_files
           WHERE collection_id = $1
           RETURNING id
         )
         SELECT COUNT(*)::int AS count FROM deleted`,
        [col.id]
      );

      return { deleted: result?.count ?? 0 };
    }
  );

  // DELETE /collections/:name/files/by-channel/:channel — delete tracked files by metadata.channel
  fastify.delete<{ Params: { name: string; channel: string } }>(
    '/collections/:name/files/by-channel/:channel',
    async (request, reply) => {
      const { name, channel } = request.params;
      const col = await querySingle<{ id: string }>(
        `SELECT id FROM kvec.collections WHERE name = $1`,
        [name]
      );
      if (!col) {
        return reply.status(404).send({ error: 'Collection not found' });
      }

      const result = await querySingle<{ count: number }>(
        `WITH deleted AS (
           DELETE FROM kvec.tracked_files
           WHERE collection_id = $1
             AND COALESCE(metadata->>'channel', '') = $2
           RETURNING id
         )
         SELECT COUNT(*)::int AS count FROM deleted`,
        [col.id, channel]
      );

      return { deleted: result?.count ?? 0 };
    }
  );

  // DELETE /collections/:name/repos/:id — delete repo + its files and chunks
  fastify.delete<{ Params: { name: string; id: string } }>(
    '/collections/:name/repos/:id',
    async (request, reply) => {
      const { name, id } = request.params;
      const col = await querySingle<{ id: string }>(
        `SELECT id FROM kvec.collections WHERE name = $1`,
        [name]
      );
      if (!col) {
        return reply.status(404).send({ error: 'Collection not found' });
      }

      const deleted = await querySingle<{ id: string }>(
        `DELETE FROM kvec.repos
         WHERE id = $1 AND collection_id = $2
         RETURNING id`,
        [id, col.id]
      );
      if (!deleted) {
        return reply.status(404).send({ error: 'Repo not found' });
      }
      return reply.status(204).send();
    }
  );

  // DELETE /collections/:name/files/:id — delete single tracked file + chunks
  fastify.delete<{ Params: { name: string; id: string } }>(
    '/collections/:name/files/:id',
    async (request, reply) => {
      const { name, id } = request.params;
      const col = await querySingle<{ id: string }>(
        `SELECT id FROM kvec.collections WHERE name = $1`,
        [name]
      );
      if (!col) {
        return reply.status(404).send({ error: 'Collection not found' });
      }

      const deleted = await querySingle<{ id: string }>(
        `DELETE FROM kvec.tracked_files
         WHERE id = $1 AND collection_id = $2
         RETURNING id`,
        [id, col.id]
      );
      if (!deleted) {
        return reply.status(404).send({ error: 'File not found' });
      }
      return reply.status(204).send();
    }
  );

  // POST /collections/:name/files/bulk-delete — delete tracked files in bulk
  fastify.post<{
    Params: { name: string };
    Body: { ids: string[] };
  }>('/collections/:name/files/bulk-delete', async (request, reply) => {
    const { name } = request.params;
    const { ids } = (request.body ?? {}) as { ids?: unknown };

    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
      return reply.status(400).send({ error: 'ids array is required' });
    }

    const col = await querySingle<{ id: string }>(
      `SELECT id FROM kvec.collections WHERE name = $1`,
      [name]
    );
    if (!col) {
      return reply.status(404).send({ error: 'Collection not found' });
    }

    try {
      const result = await querySingle<{ count: number }>(
        `WITH deleted AS (
           DELETE FROM kvec.tracked_files
           WHERE id = ANY($1::uuid[]) AND collection_id = $2
           RETURNING id
         )
         SELECT COUNT(*)::int AS count FROM deleted`,
        [ids, col.id]
      );
      return { deleted: result?.count ?? 0 };
    } catch {
      return reply.status(400).send({ error: 'Invalid file ids' });
    }
  });

  // GET /collections/:name/languages — language distribution
  fastify.get<{ Params: { name: string } }>('/collections/:name/languages', async (request, reply) => {
    const { name } = request.params;
    const col = await querySingle<{ id: string }>(
      `SELECT id FROM kvec.collections WHERE name = $1`,
      [name]
    );
    if (!col) {
      return reply.status(404).send({ error: 'Collection not found' });
    }

    const rows = await query(
      `SELECT COALESCE(language, 'unknown') AS language, COUNT(*)::int AS count
       FROM kvec.tracked_files
       WHERE collection_id = $1
       GROUP BY language
       ORDER BY count DESC`,
      [col.id]
    );
    return { languages: rows };
  });

  // ===========================================================================
  // Embed jobs — source code embedding via UI
  // ===========================================================================

  // GET /embed/health — check embed server availability
  fastify.get('/embed/health', async () => {
    return checkEmbedServerHealth();
  });

  // POST /embed/jobs — start a new embed job
  fastify.post<{
    Body: {
      path: string;
      extensions?: string[];
      batchSize?: number;
      batchDelayMs?: number;
    };
  }>('/embed/jobs', async (request, reply) => {
    const { path: inputPath, extensions, batchSize, batchDelayMs } = request.body ?? {} as any;

    if (!inputPath || typeof inputPath !== 'string') {
      return reply.status(400).send({ error: 'path is required' });
    }

    try {
      const job = startEmbedJob({ path: inputPath, extensions, batchSize, batchDelayMs });
      return reply.status(201).send({ job });
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // GET /embed/jobs — list all embed jobs
  fastify.get('/embed/jobs', async () => {
    return { jobs: listJobs() };
  });

  // GET /embed/jobs/:id — get a single embed job
  fastify.get<{ Params: { id: string } }>('/embed/jobs/:id', async (request, reply) => {
    const job = getJob(request.params.id);
    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }
    return { job };
  });

  // POST /embed/jobs/:id/cancel — cancel a running or queued embed job
  fastify.post<{ Params: { id: string } }>('/embed/jobs/:id/cancel', async (request, reply) => {
    const job = cancelJob(request.params.id);
    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }
    return { job };
  });

  // DELETE /embed/jobs/:id — delete a completed/failed/cancelled job from history
  fastify.delete<{ Params: { id: string } }>('/embed/jobs/:id', async (request, reply) => {
    const deleted = deleteJob(request.params.id);
    if (!deleted) {
      return reply.status(400).send({ error: 'Job not found or still running' });
    }
    return reply.status(204).send();
  });

  // ===========================================================================
  // Git info — branch detection for embed UI
  // ===========================================================================

  // GET /embed/git-info?path=... — detect branches and current branch
  fastify.get<{ Querystring: { path: string } }>('/embed/git-info', async (request, reply) => {
    const { path: inputPath } = request.query;
    if (!inputPath || typeof inputPath !== 'string') {
      return reply.status(400).send({ error: 'path query parameter is required' });
    }

    try {
      const { execSync } = await import('child_process');
      const opts = { cwd: inputPath, encoding: 'utf-8' as const, timeout: 5000 };

      // Current branch
      let currentBranch = '';
      try {
        currentBranch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
      } catch { /* not a git repo or detached HEAD */ }

      if (!currentBranch) {
        return reply.status(400).send({ error: 'Not a git repository' });
      }

      // Local branches
      const localRaw = execSync("git branch --format='%(refname:short)'", opts).trim();
      const localBranches = localRaw
        ? localRaw.split('\n').map((b) => b.replace(/^'|'$/g, '')).filter(Boolean)
        : [];

      // Remote branches
      let remoteBranches: string[] = [];
      try {
        const remoteRaw = execSync("git branch -r --format='%(refname:short)'", opts).trim();
        remoteBranches = remoteRaw
          ? remoteRaw.split('\n')
              .map((b) => b.replace(/^'|'$/g, ''))
              .filter((b) => Boolean(b) && !b.includes('/HEAD'))
          : [];
      } catch { /* no remotes */ }

      return { currentBranch, localBranches, remoteBranches };
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // POST /embed/checkout — switch branch in a repo by path
  fastify.post<{
    Body: { path: string; branch: string };
  }>('/embed/checkout', async (request, reply) => {
    const { path: inputPath, branch } = request.body ?? {} as any;

    if (!inputPath || typeof inputPath !== 'string') {
      return reply.status(400).send({ error: 'path is required' });
    }
    if (!branch || typeof branch !== 'string') {
      return reply.status(400).send({ error: 'branch is required' });
    }

    try {
      const { checkoutBranch } = await import('../services/git');
      const current = await checkoutBranch(inputPath, branch);
      return { current };
    } catch (err: any) {
      return reply.status(409).send({ error: err.message });
    }
  });

  // ===========================================================================
  // Commit embed jobs — git commit history embedding
  // ===========================================================================

  // POST /embed/commit-jobs — start a new commit embed job
  fastify.post<{
    Body: {
      path: string;
      limit?: number;
      since?: string;
      until?: string;
      branch?: string;
      batchSize?: number;
      batchDelayMs?: number;
    };
  }>('/embed/commit-jobs', async (request, reply) => {
    const { path: inputPath, limit, since, until, branch, batchSize, batchDelayMs } = request.body ?? {} as any;

    if (!inputPath || typeof inputPath !== 'string') {
      return reply.status(400).send({ error: 'path is required' });
    }

    try {
      const job = startCommitEmbedJob({ path: inputPath, limit, since, until, branch, batchSize, batchDelayMs });
      return reply.status(201).send({ job });
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // GET /collections/:name/doc-paths — distinct parent directories for doc files
  fastify.get<{ Params: { name: string } }>('/collections/:name/doc-paths', async (request, reply) => {
    const { name } = request.params;
    const col = await querySingle<{ id: string }>(
      `SELECT id FROM kvec.collections WHERE name = $1`,
      [name]
    );
    if (!col) {
      return reply.status(404).send({ error: 'Collection not found' });
    }

    const rows = await query(
      `SELECT
         regexp_replace(f.file_path, '/[^/]+$', '') AS dir_path,
         COUNT(*)::int AS file_count,
         MAX(f.uploaded_at) AS last_upload
       FROM kvec.tracked_files f
       WHERE f.collection_id = $1
       GROUP BY dir_path
       ORDER BY last_upload DESC`,
      [col.id]
    );
    return { paths: rows };
  });

  // ===========================================================================
  // Document embed jobs — markdown, PDF, text file embedding
  // ===========================================================================

  // POST /embed/doc-jobs — start a new document embed job
  fastify.post<{
    Body: {
      path: string;
      extensions?: string[];
      project_handle?: string;
      tags?: string[];
      title?: string;
      batchSize?: number;
      batchDelayMs?: number;
    };
  }>('/embed/doc-jobs', async (request, reply) => {
    const { path: inputPath, extensions, project_handle, tags, title, batchSize, batchDelayMs } = request.body ?? {} as any;

    if (!inputPath || typeof inputPath !== 'string') {
      return reply.status(400).send({ error: 'path is required' });
    }

    try {
      const job = startDocEmbedJob({
        path: inputPath,
        extensions,
        projectHandle: project_handle,
        tags,
        title,
        batchSize,
        batchDelayMs,
      });
      return reply.status(201).send({ job });
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // GET /embed/doc-jobs — list all document embed jobs
  fastify.get('/embed/doc-jobs', async () => {
    return { jobs: listDocJobs() };
  });

  // GET /embed/doc-jobs/:id — get a single document embed job
  fastify.get<{ Params: { id: string } }>('/embed/doc-jobs/:id', async (request, reply) => {
    const job = getDocJob(request.params.id);
    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }
    return { job };
  });

  // POST /embed/doc-jobs/:id/cancel — cancel a running or queued doc embed job
  fastify.post<{ Params: { id: string } }>('/embed/doc-jobs/:id/cancel', async (request, reply) => {
    const job = cancelDocJob(request.params.id);
    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }
    return { job };
  });

  // DELETE /embed/doc-jobs/:id — delete a completed/failed/cancelled doc job
  fastify.delete<{ Params: { id: string } }>('/embed/doc-jobs/:id', async (request, reply) => {
    const deleted = deleteDocJob(request.params.id);
    if (!deleted) {
      return reply.status(400).send({ error: 'Job not found or still running' });
    }
    return reply.status(204).send();
  });
};

export default kvecRoutes;
