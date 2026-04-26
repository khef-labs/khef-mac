import { FastifyPluginAsync } from 'fastify';
import { query, querySingle } from '../db/client';
import { Comment, CreateCommentInput, UpdateCommentInput, PaginationMetadata, CommentEntityType } from '../types';

const VALID_STATUSES = ['active', 'orphaned', 'resolved'];
const VALID_AUTHORS = ['user', 'claude-code', 'codex-cli'];

/**
 * Memory comment routes - /api/memories/:memoryId/comments
 * Keeps backward compatibility while using polymorphic entity_type/entity_id internally
 */
const commentRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/memories/:memoryId/comments
  fastify.get('/', async (request, reply) => {
    const { memoryId } = request.params as { memoryId: string };
    const { limit = '20', offset = '0', order = 'asc', status } = request.query as {
      limit?: string;
      offset?: string;
      order?: string;
      status?: string;
    };

    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const offsetNum = parseInt(offset, 10) || 0;
    const orderDir = order?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const memory = await querySingle('SELECT id FROM memories WHERE id = $1', [memoryId]);
    if (!memory) {
      return reply.code(404).send({ error: 'Memory not found' });
    }

    const conditions = ["entity_type = 'memory'", 'entity_id = $1'];
    const params: any[] = [memoryId];
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

  // DELETE /api/memories/:memoryId/comments
  fastify.delete('/', async (request, reply) => {
    const { memoryId } = request.params as { memoryId: string };
    const { status, confirm } = request.query as { status?: string; confirm?: string };

    const memory = await querySingle('SELECT id FROM memories WHERE id = $1', [memoryId]);
    if (!memory) {
      return reply.code(404).send({ error: 'Memory not found' });
    }

    if (!status && confirm !== 'true') {
      return reply.code(400).send({ error: 'status is required unless confirm=true' });
    }
    if (status && !VALID_STATUSES.includes(status)) {
      return reply.code(400).send({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const conditions = ["entity_type = 'memory'", 'entity_id = $1'];
    const params: any[] = [memoryId];
    let idx = 2;

    if (status) {
      conditions.push(`status = $${idx}`);
      params.push(status);
      idx++;
    }

    const where = conditions.join(' AND ');
    const deleted = await query<{ id: string }>(
      `DELETE FROM comments WHERE ${where} RETURNING id`,
      params
    );

    return { deleted_count: deleted.length };
  });

  // POST /api/memories/:memoryId/comments
  fastify.post('/', async (request, reply) => {
    const { memoryId } = request.params as { memoryId: string };
    const body = request.body as CreateCommentInput;

    if (!body.content || !body.content.trim()) {
      return reply.code(400).send({ error: 'content is required' });
    }
    if (body.content.length > 5000) {
      return reply.code(400).send({ error: 'content must be 5000 characters or less' });
    }

    // Validate author if provided
    const author = body.author || 'user';
    if (!VALID_AUTHORS.includes(author)) {
      return reply.code(400).send({ error: `author must be one of: ${VALID_AUTHORS.join(', ')}` });
    }

    const memory = await querySingle('SELECT id FROM memories WHERE id = $1', [memoryId]);
    if (!memory) {
      return reply.code(404).send({ error: 'Memory not found' });
    }

    // Validate parent_comment_id if provided (for replies)
    if (body.parent_comment_id) {
      const parentComment = await querySingle<Comment>(
        "SELECT id, parent_comment_id FROM comments WHERE id = $1 AND entity_type = 'memory' AND entity_id = $2",
        [body.parent_comment_id, memoryId]
      );
      if (!parentComment) {
        return reply.code(400).send({ error: 'Parent comment not found' });
      }
      // Enforce 1 level nesting: replies can't have replies
      if (parentComment.parent_comment_id) {
        return reply.code(400).send({ error: 'Replies cannot have replies (1 level nesting only)' });
      }
    }

    const result = await query<Comment>(
      `INSERT INTO comments (entity_type, entity_id, content, author, parent_comment_id, anchor_text, anchor_prefix, anchor_suffix)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        'memory' as CommentEntityType,
        memoryId,
        body.content.trim(),
        author,
        body.parent_comment_id ?? null,
        body.anchor_text ?? null,
        body.anchor_prefix ?? null,
        body.anchor_suffix ?? null,
      ]
    );

    return reply.code(201).send({ comment: result[0] });
  });

  // PATCH /api/memories/:memoryId/comments/:commentId
  fastify.patch('/:commentId', async (request, reply) => {
    const { memoryId, commentId } = request.params as { memoryId: string; commentId: string };
    const body = request.body as UpdateCommentInput;

    const hasContent = body.content !== undefined;
    const hasAnchorText = body.anchor_text !== undefined;
    const hasAnchorPrefix = body.anchor_prefix !== undefined;
    const hasAnchorSuffix = body.anchor_suffix !== undefined;
    const hasStatus = body.status !== undefined;

    if (!hasContent && !hasAnchorText && !hasAnchorPrefix && !hasAnchorSuffix && !hasStatus) {
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
    if (hasStatus) {
      sets.push(`status = $${idx}`);
      params.push(body.status);
      idx++;
    }

    params.push(commentId, memoryId);

    const result = await query<Comment>(
      `UPDATE comments SET ${sets.join(', ')} WHERE id = $${idx} AND entity_type = 'memory' AND entity_id = $${idx + 1} RETURNING *`,
      params
    );

    if (result.length === 0) {
      return reply.code(404).send({ error: 'Comment not found' });
    }

    return { comment: result[0] };
  });

  // DELETE /api/memories/:memoryId/comments/:commentId
  fastify.delete('/:commentId', async (request, reply) => {
    const { memoryId, commentId } = request.params as { memoryId: string; commentId: string };

    const result = await query(
      "DELETE FROM comments WHERE id = $1 AND entity_type = 'memory' AND entity_id = $2 RETURNING id",
      [commentId, memoryId]
    );

    if (result.length === 0) {
      return reply.code(404).send({ error: 'Comment not found' });
    }

    return reply.code(204).send();
  });
};

export default commentRoutes;
