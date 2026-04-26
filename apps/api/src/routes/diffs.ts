/**
 * Diff routes - record management and comments.
 * Diff content is computed live from git; only metadata stored.
 */
import { FastifyPluginAsync } from 'fastify';
import { query, querySingle } from '../db/client';
import { resolveProject } from './projects';
import { resolveProjectPath } from '../services/project-path';
import { getCommitDiff, getWorkingDiff, isGitRepo, sanitizeRef } from '../services/git';
import { Comment, CreateCommentInput, UpdateCommentInput, PaginationMetadata, CommentEntityType } from '../types';

const VALID_STATUSES = ['active', 'orphaned', 'resolved'];
const VALID_AUTHORS = ['user', 'claude-code', 'codex-cli'];

interface DiffRecord {
  id: string;
  project_id: string;
  branch: string;
  commit_sha: string | null;
  parent_sha: string | null;
  path: string | null;
  created_at: string;
  deleted_at: string | null;
}

interface DiffWithContent extends DiffRecord {
  diff: string;
  stats: { files: number; insertions: number; deletions: number };
}

/**
 * Project-scoped diff routes - /api/projects/:projectId/diffs
 */
export const projectDiffRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/projects/:projectId/diffs - List diff records
  fastify.get('/', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { branch, limit = '20', offset = '0' } = request.query as {
      branch?: string;
      limit?: string;
      offset?: string;
    };

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const offsetNum = parseInt(offset, 10) || 0;

    const conditions = ['project_id = $1', 'deleted_at IS NULL'];
    const params: any[] = [project.id];
    let idx = 2;

    if (branch) {
      conditions.push(`branch = $${idx}`);
      params.push(sanitizeRef(branch));
      idx++;
    }

    const where = conditions.join(' AND ');

    const countResult = await querySingle<{ count: string }>(
      `SELECT COUNT(*) as count FROM diffs WHERE ${where}`,
      params
    );
    const totalCount = parseInt(countResult?.count || '0', 10);

    // Get diffs with comment counts
    const diffs = await query<DiffRecord & { comment_count: string }>(
      `SELECT d.*,
              (SELECT COUNT(*) FROM comments c WHERE c.entity_type = 'diff' AND c.entity_id = d.id) as comment_count
       FROM diffs d
       WHERE ${where}
       ORDER BY d.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limitNum, offsetNum]
    );

    const pagination: PaginationMetadata = {
      total_count: totalCount,
      limit: limitNum,
      offset: offsetNum,
      has_more: offsetNum + limitNum < totalCount,
    };

    return {
      diffs: diffs.map(d => ({ ...d, comment_count: parseInt(d.comment_count, 10) })),
      pagination,
    };
  });

  // GET /api/projects/:projectId/diffs/by-commit/:sha - Find diff by commit SHA (legacy, use by-ref)
  fastify.get('/by-commit/:sha', async (request, reply) => {
    const { projectId, sha } = request.params as { projectId: string; sha: string };
    const { path } = request.query as { path?: string };

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const safeSha = sanitizeRef(sha);

    const diff = await querySingle<DiffRecord>(
      `SELECT * FROM diffs
       WHERE project_id = $1
         AND commit_sha = $2
         AND (path = $3 OR (path IS NULL AND $3 IS NULL))
         AND deleted_at IS NULL`,
      [project.id, safeSha, path ?? null]
    );

    if (!diff) {
      return reply.code(404).send({ error: 'Diff record not found for this commit' });
    }

    // Get comments for this diff
    const comments = await query<Comment>(
      `SELECT * FROM comments
       WHERE entity_type = 'diff' AND entity_id = $1
       ORDER BY created_at ASC`,
      [diff.id]
    );

    return { diff, comments };
  });

  // GET /api/projects/:projectId/diffs/by-ref/:ref - Find diff by ref ("working" or commit SHA)
  // Supports: "working" for uncommitted, short SHA (7+ chars), or full SHA (40 chars)
  fastify.get('/by-ref/:ref', async (request, reply) => {
    const { projectId, ref } = request.params as { projectId: string; ref: string };
    const { path } = request.query as { path?: string };

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    let diff: DiffRecord | null = null;

    if (ref.toLowerCase() === 'working') {
      // Check if working tree is clean and soft-delete if so
      const projectPath = await resolveProjectPath(project);
      if (projectPath && await isGitRepo(projectPath)) {
        try {
          const workingDiff = await getWorkingDiff(projectPath, path);
          if (workingDiff.combined.stats.files === 0) {
            // Working tree is clean - soft-delete any active working tree diff
            await query(
              `UPDATE diffs
               SET deleted_at = NOW()
               WHERE project_id = $1
                 AND commit_sha IS NULL
                 AND deleted_at IS NULL`,
              [project.id]
            );
            return reply.code(404).send({ error: 'Diff record not found' });
          }
        } catch {
          // Git operation failed - continue to look for existing record
        }
      }

      // Uncommitted changes - only active
      diff = await querySingle<DiffRecord>(
        `SELECT * FROM diffs
         WHERE project_id = $1
           AND commit_sha IS NULL
           AND (path = $2 OR (path IS NULL AND $2 IS NULL))
           AND deleted_at IS NULL`,
        [project.id, path ?? null]
      );
    } else {
      // Commit SHA (short or full)
      const safeSha = sanitizeRef(ref);

      if (safeSha.length === 40) {
        // Full SHA - exact match, only active
        diff = await querySingle<DiffRecord>(
          `SELECT * FROM diffs
           WHERE project_id = $1
             AND commit_sha = $2
             AND (path = $3 OR (path IS NULL AND $3 IS NULL))
             AND deleted_at IS NULL`,
          [project.id, safeSha, path ?? null]
        );
      } else if (safeSha.length >= 7) {
        // Short SHA - prefix match, only active
        diff = await querySingle<DiffRecord>(
          `SELECT * FROM diffs
           WHERE project_id = $1
             AND commit_sha LIKE $2
             AND (path = $3 OR (path IS NULL AND $3 IS NULL))
             AND deleted_at IS NULL`,
          [project.id, `${safeSha}%`, path ?? null]
        );
      } else {
        return reply.code(400).send({ error: 'SHA must be at least 7 characters' });
      }
    }

    if (!diff) {
      return reply.code(404).send({ error: 'Diff record not found' });
    }

    // Get comments for this diff
    const comments = await query<Comment>(
      `SELECT * FROM comments
       WHERE entity_type = 'diff' AND entity_id = $1
       ORDER BY created_at ASC`,
      [diff.id]
    );

    return { diff, comments };
  });

  // POST /api/projects/:projectId/diffs/by-ref/:ref/comments - Create comment (and diff record if needed)
  // This is the preferred way to add comments - creates diff record lazily
  fastify.post('/by-ref/:ref/comments', async (request, reply) => {
    const { projectId, ref } = request.params as { projectId: string; ref: string };
    const body = request.body as CreateCommentInput & { branch?: string; path?: string };

    if (!body.content || !body.content.trim()) {
      return reply.code(400).send({ error: 'content is required' });
    }
    if (body.content.length > 5000) {
      return reply.code(400).send({ error: 'content must be 5000 characters or less' });
    }

    const author = body.author || 'user';
    if (!VALID_AUTHORS.includes(author)) {
      return reply.code(400).send({ error: `author must be one of: ${VALID_AUTHORS.join(', ')}` });
    }

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Determine commit_sha based on ref
    let commitSha: string | null = null;
    if (ref.toLowerCase() !== 'working') {
      const safeSha = sanitizeRef(ref);
      if (safeSha.length < 7) {
        return reply.code(400).send({ error: 'SHA must be at least 7 characters' });
      }
      // For short SHAs, we need to resolve to full SHA or store the short one
      // For now, require full SHA for commit comments
      if (safeSha.length !== 40) {
        return reply.code(400).send({ error: 'Full 40-character SHA required for commit comments' });
      }
      commitSha = safeSha;
    }

    const path = body.path ?? null;

    // Find or create diff record
    let diff = await querySingle<DiffRecord>(
      `SELECT * FROM diffs
       WHERE project_id = $1
         AND (commit_sha = $2 OR (commit_sha IS NULL AND $2 IS NULL))
         AND (path = $3 OR (path IS NULL AND $3 IS NULL))
         AND deleted_at IS NULL`,
      [project.id, commitSha, path]
    );

    if (!diff) {
      // Need branch to create new record
      if (!body.branch) {
        return reply.code(400).send({ error: 'branch is required when creating new diff record' });
      }
      const branch = sanitizeRef(body.branch);

      const result = await query<DiffRecord>(
        `INSERT INTO diffs (project_id, branch, commit_sha, path)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [project.id, branch, commitSha, path]
      );
      diff = result[0];
    }

    // Validate parent_comment_id if provided
    if (body.parent_comment_id) {
      const parentComment = await querySingle<Comment>(
        "SELECT id, parent_comment_id FROM comments WHERE id = $1 AND entity_type = 'diff' AND entity_id = $2",
        [body.parent_comment_id, diff.id]
      );
      if (!parentComment) {
        return reply.code(400).send({ error: 'Parent comment not found' });
      }
      if (parentComment.parent_comment_id) {
        return reply.code(400).send({ error: 'Replies cannot have replies (1 level nesting only)' });
      }
    }

    // Create the comment
    const result = await query<Comment>(
      `INSERT INTO comments (entity_type, entity_id, content, author, parent_comment_id, anchor_text, anchor_prefix, anchor_suffix, anchor_path, anchor_line)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        'diff' as CommentEntityType,
        diff.id,
        body.content.trim(),
        author,
        body.parent_comment_id ?? null,
        body.anchor_text ?? null,
        body.anchor_prefix ?? null,
        body.anchor_suffix ?? null,
        body.anchor_path ?? null,
        body.anchor_line ?? null,
      ]
    );

    return reply.code(201).send({ comment: result[0], diff });
  });

  // GET /api/projects/:projectId/diffs/deleted - List soft-deleted working tree diffs
  fastify.get('/deleted', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { branch } = request.query as { branch?: string };

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const conditions = ['project_id = $1', 'commit_sha IS NULL', 'deleted_at IS NOT NULL'];
    const params: any[] = [project.id];
    let idx = 2;

    if (branch) {
      conditions.push(`branch = $${idx}`);
      params.push(sanitizeRef(branch));
      idx++;
    }

    const diffs = await query<{ id: string; branch: string; created_at: string; deleted_at: string }>(
      `SELECT id, branch, created_at, deleted_at
       FROM diffs
       WHERE ${conditions.join(' AND ')}
       ORDER BY deleted_at DESC`,
      params
    );

    return { diffs };
  });

  // DELETE /api/projects/:projectId/diffs/deleted - Bulk hard-delete soft-deleted working tree diffs
  fastify.delete('/deleted', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { branch } = request.query as { branch?: string };

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const conditions = ['project_id = $1', 'commit_sha IS NULL', 'deleted_at IS NOT NULL'];
    const params: any[] = [project.id];
    let idx = 2;

    if (branch) {
      conditions.push(`branch = $${idx}`);
      params.push(sanitizeRef(branch));
      idx++;
    }

    const where = conditions.join(' AND ');

    // Delete comments first (polymorphic, no FK cascade)
    await query(
      `DELETE FROM comments
       WHERE entity_type = 'diff'
         AND entity_id IN (SELECT id FROM diffs WHERE ${where})`,
      params
    );

    // Then delete the diff records
    const result = await query<{ id: string }>(
      `DELETE FROM diffs WHERE ${where} RETURNING id`,
      params
    );

    return { deleted_count: result.length };
  });
};

/**
 * Global diff routes - /api/diffs/:diffId
 */
export const globalDiffRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/diffs/:diffId - Get diff with computed content + comments
  fastify.get('/', async (request, reply) => {
    const { diffId } = request.params as { diffId: string };

    const diff = await querySingle<DiffRecord & { project_path: string | null; project_handle: string }>(
      `SELECT d.*, p.path as project_path, p.handle as project_handle
       FROM diffs d
       JOIN projects p ON d.project_id = p.id
       WHERE d.id = $1`,
      [diffId]
    );

    if (!diff) {
      return reply.code(404).send({ error: 'Diff not found' });
    }

    // Get project path for git operations
    const projectPath = await resolveProjectPath({ path: diff.project_path, handle: diff.project_handle });

    let content = '';
    let stats = { files: 0, insertions: 0, deletions: 0 };

    if (projectPath && await isGitRepo(projectPath)) {
      try {
        if (diff.commit_sha) {
          const result = await getCommitDiff(projectPath, diff.commit_sha, diff.path ?? undefined);
          content = result.diff;
          stats = result.stats;
        } else {
          const result = await getWorkingDiff(projectPath, diff.path ?? undefined);
          content = result.combined.diff;
          stats = result.combined.stats;
        }
      } catch (err) {
        // Git operation failed - return empty diff with error note
        content = `# Error computing diff: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    } else {
      content = '# Project path not configured or not a git repository';
    }

    // Get comments
    const comments = await query<Comment>(
      `SELECT * FROM comments
       WHERE entity_type = 'diff' AND entity_id = $1
       ORDER BY created_at ASC`,
      [diffId]
    );

    return {
      diff: {
        id: diff.id,
        project_id: diff.project_id,
        branch: diff.branch,
        commit_sha: diff.commit_sha,
        parent_sha: diff.parent_sha,
        path: diff.path,
        created_at: diff.created_at,
      },
      content,
      stats,
      comments,
    };
  });

  // DELETE /api/diffs/:diffId - Hard-delete a diff and its comments
  fastify.delete('/', async (request, reply) => {
    const { diffId } = request.params as { diffId: string };

    const diff = await querySingle('SELECT id FROM diffs WHERE id = $1', [diffId]);
    if (!diff) {
      return reply.code(404).send({ error: 'Diff not found' });
    }

    // Delete comments first (polymorphic, no FK cascade)
    await query(
      "DELETE FROM comments WHERE entity_type = 'diff' AND entity_id = $1",
      [diffId]
    );

    // Delete the diff record
    await query('DELETE FROM diffs WHERE id = $1', [diffId]);

    return reply.code(204).send();
  });
};

/**
 * Diff comment routes - /api/diffs/:diffId/comments
 */
export const diffCommentRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/diffs/:diffId/comments
  fastify.get('/', async (request, reply) => {
    const { diffId } = request.params as { diffId: string };
    const { limit = '20', offset = '0', order = 'asc', status } = request.query as {
      limit?: string;
      offset?: string;
      order?: string;
      status?: string;
    };

    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const offsetNum = parseInt(offset, 10) || 0;
    const orderDir = order?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const diff = await querySingle('SELECT id FROM diffs WHERE id = $1', [diffId]);
    if (!diff) {
      return reply.code(404).send({ error: 'Diff not found' });
    }

    const conditions = ["entity_type = 'diff'", 'entity_id = $1'];
    const params: any[] = [diffId];
    let idx = 2;

    if (status && VALID_STATUSES.includes(status)) {
      conditions.push(`status = $${idx}`);
      params.push(status);
      idx++;
    }

    const where = conditions.join(' AND ');

    const countResult = await querySingle<{ count: string }>(
      `SELECT COUNT(*) as count FROM comments WHERE ${where}`,
      params
    );
    const totalCount = parseInt(countResult?.count || '0', 10);

    const comments = await query<Comment>(
      `SELECT * FROM comments WHERE ${where} ORDER BY created_at ${orderDir} LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limitNum, offsetNum]
    );

    const pagination: PaginationMetadata = {
      total_count: totalCount,
      limit: limitNum,
      offset: offsetNum,
      has_more: offsetNum + limitNum < totalCount,
    };

    return { comments, pagination };
  });

  // POST /api/diffs/:diffId/comments
  fastify.post('/', async (request, reply) => {
    const { diffId } = request.params as { diffId: string };
    const body = request.body as CreateCommentInput;

    if (!body.content || !body.content.trim()) {
      return reply.code(400).send({ error: 'content is required' });
    }
    if (body.content.length > 5000) {
      return reply.code(400).send({ error: 'content must be 5000 characters or less' });
    }

    const author = body.author || 'user';
    if (!VALID_AUTHORS.includes(author)) {
      return reply.code(400).send({ error: `author must be one of: ${VALID_AUTHORS.join(', ')}` });
    }

    const diff = await querySingle('SELECT id FROM diffs WHERE id = $1', [diffId]);
    if (!diff) {
      return reply.code(404).send({ error: 'Diff not found' });
    }

    // Validate parent_comment_id if provided
    if (body.parent_comment_id) {
      const parentComment = await querySingle<Comment>(
        "SELECT id, parent_comment_id FROM comments WHERE id = $1 AND entity_type = 'diff' AND entity_id = $2",
        [body.parent_comment_id, diffId]
      );
      if (!parentComment) {
        return reply.code(400).send({ error: 'Parent comment not found' });
      }
      if (parentComment.parent_comment_id) {
        return reply.code(400).send({ error: 'Replies cannot have replies (1 level nesting only)' });
      }
    }

    const result = await query<Comment>(
      `INSERT INTO comments (entity_type, entity_id, content, author, parent_comment_id, anchor_text, anchor_prefix, anchor_suffix, anchor_path, anchor_line)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        'diff' as CommentEntityType,
        diffId,
        body.content.trim(),
        author,
        body.parent_comment_id ?? null,
        body.anchor_text ?? null,
        body.anchor_prefix ?? null,
        body.anchor_suffix ?? null,
        body.anchor_path ?? null,
        body.anchor_line ?? null,
      ]
    );

    return reply.code(201).send({ comment: result[0] });
  });

  // PATCH /api/diffs/:diffId/comments/:commentId
  fastify.patch('/:commentId', async (request, reply) => {
    const { diffId, commentId } = request.params as { diffId: string; commentId: string };
    const body = request.body as UpdateCommentInput;

    const hasContent = body.content !== undefined;
    const hasAnchorText = body.anchor_text !== undefined;
    const hasAnchorPrefix = body.anchor_prefix !== undefined;
    const hasAnchorSuffix = body.anchor_suffix !== undefined;
    const hasAnchorPath = body.anchor_path !== undefined;
    const hasAnchorLine = body.anchor_line !== undefined;
    const hasStatus = body.status !== undefined;

    if (!hasContent && !hasAnchorText && !hasAnchorPrefix && !hasAnchorSuffix && !hasAnchorPath && !hasAnchorLine && !hasStatus) {
      return reply.code(400).send({ error: 'At least one field is required' });
    }
    if (hasContent && body.content!.length > 5000) {
      return reply.code(400).send({ error: 'content must be 5000 characters or less' });
    }
    if (hasStatus && !VALID_STATUSES.includes(body.status!)) {
      return reply.code(400).send({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (hasContent) {
      sets.push(`content = $${idx}`);
      params.push(body.content!.trim());
      idx++;
    }
    if (hasAnchorText) {
      sets.push(`anchor_text = $${idx}`);
      params.push(body.anchor_text);
      idx++;
    }
    if (hasAnchorPrefix) {
      sets.push(`anchor_prefix = $${idx}`);
      params.push(body.anchor_prefix);
      idx++;
    }
    if (hasAnchorSuffix) {
      sets.push(`anchor_suffix = $${idx}`);
      params.push(body.anchor_suffix);
      idx++;
    }
    if (hasAnchorPath) {
      sets.push(`anchor_path = $${idx}`);
      params.push(body.anchor_path);
      idx++;
    }
    if (hasAnchorLine) {
      sets.push(`anchor_line = $${idx}`);
      params.push(body.anchor_line);
      idx++;
    }
    if (hasStatus) {
      sets.push(`status = $${idx}`);
      params.push(body.status);
      idx++;
    }

    params.push(commentId, diffId);

    const result = await query<Comment>(
      `UPDATE comments SET ${sets.join(', ')} WHERE id = $${idx} AND entity_type = 'diff' AND entity_id = $${idx + 1} RETURNING *`,
      params
    );

    if (result.length === 0) {
      return reply.code(404).send({ error: 'Comment not found' });
    }

    return { comment: result[0] };
  });

  // DELETE /api/diffs/:diffId/comments/:commentId
  fastify.delete('/:commentId', async (request, reply) => {
    const { diffId, commentId } = request.params as { diffId: string; commentId: string };

    const result = await query(
      "DELETE FROM comments WHERE id = $1 AND entity_type = 'diff' AND entity_id = $2 RETURNING id",
      [commentId, diffId]
    );

    if (result.length === 0) {
      return reply.code(404).send({ error: 'Comment not found' });
    }

    return reply.code(204).send();
  });
};

export default projectDiffRoutes;
