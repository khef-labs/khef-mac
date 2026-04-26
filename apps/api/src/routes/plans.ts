import { FastifyPluginAsync } from 'fastify';
import { query, querySingle } from '../db/client';
import { Comment, CreateCommentInput, UpdateCommentInput, PaginationMetadata, CommentEntityType } from '../types';
import { Plan } from '../services/plans';
import { markdownToSlack } from '../services/markdown-to-slack';
import { planToDocx } from '../services/plan-to-docx';

const VALID_EXPORT_FORMATS = ['markdown', 'slack', 'docx'] as const;
type ExportFormat = (typeof VALID_EXPORT_FORMATS)[number];

const VALID_STATUSES = ['active', 'orphaned', 'resolved'];
const VALID_AUTHORS = ['user', 'claude-code', 'codex-cli'];

interface PlanWithComments extends Plan {
  comments: Comment[];
}

/**
 * Plan routes - /api/plans/:id
 * Provides access to plans by ID with comments
 */
const planRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/plans/:id - Get plan by ID with comments
  fastify.get<{
    Params: { id: string };
  }>('/:id', async (request, reply) => {
    const { id } = request.params;

    // Get plan with current version
    const plan = await querySingle<Plan & { version_count: string }>(
      `SELECT
         p.id,
         p.filename,
         p.file_path,
         pv.title,
         pv.content,
         p.current_version,
         (SELECT COUNT(*) FROM plan_versions WHERE plan_id = p.id) as version_count,
         p.status,
         p.project_id,
         (p.file_path IS NOT NULL) as has_file,
         pv.size,
         p.created_at,
         p.updated_at
       FROM plans p
       JOIN plan_versions pv ON pv.plan_id = p.id AND pv.version = p.current_version
       WHERE p.id = $1`,
      [id]
    );

    if (!plan) {
      return reply.code(404).send({ error: 'Plan not found' });
    }

    // Get comments for this plan
    const comments = await query<Comment>(
      `SELECT * FROM comments
       WHERE entity_type = 'plan' AND entity_id = $1
       ORDER BY created_at ASC`,
      [id]
    );

    return {
      plan: {
        ...plan,
        version_count: parseInt(plan.version_count as unknown as string, 10),
      },
      comments,
    };
  });

  // GET /api/plans/:id/comments - List comments for a plan
  fastify.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string; order?: string; status?: string };
  }>('/:id/comments', async (request, reply) => {
    const { id } = request.params;
    const { limit = '20', offset = '0', order = 'asc', status } = request.query;

    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const offsetNum = parseInt(offset, 10) || 0;
    const orderDir = order?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    // Check plan exists
    const plan = await querySingle('SELECT id FROM plans WHERE id = $1', [id]);
    if (!plan) {
      return reply.code(404).send({ error: 'Plan not found' });
    }

    const conditions = ["entity_type = 'plan'", 'entity_id = $1'];
    const params: any[] = [id];
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

  // POST /api/plans/:id/comments - Create comment on a plan
  fastify.post<{
    Params: { id: string };
    Body: CreateCommentInput;
  }>('/:id/comments', async (request, reply) => {
    const { id } = request.params;
    const body = request.body;

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

    // Check plan exists
    const plan = await querySingle('SELECT id FROM plans WHERE id = $1', [id]);
    if (!plan) {
      return reply.code(404).send({ error: 'Plan not found' });
    }

    // Validate parent_comment_id if provided (for replies)
    if (body.parent_comment_id) {
      const parentComment = await querySingle<Comment>(
        "SELECT id, parent_comment_id FROM comments WHERE id = $1 AND entity_type = 'plan' AND entity_id = $2",
        [body.parent_comment_id, id]
      );
      if (!parentComment) {
        return reply.code(400).send({ error: 'Parent comment not found' });
      }
      if (parentComment.parent_comment_id) {
        return reply.code(400).send({ error: 'Replies cannot have replies (1 level nesting only)' });
      }
    }

    const result = await query<Comment>(
      `INSERT INTO comments (entity_type, entity_id, content, author, parent_comment_id, anchor_text, anchor_prefix, anchor_suffix)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        'plan' as CommentEntityType,
        id,
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

  // PATCH /api/plans/:id/comments/:commentId - Update a comment
  fastify.patch<{
    Params: { id: string; commentId: string };
    Body: UpdateCommentInput;
  }>('/:id/comments/:commentId', async (request, reply) => {
    const { id, commentId } = request.params;
    const body = request.body;

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

    params.push(commentId, id);

    const result = await query<Comment>(
      `UPDATE comments SET ${sets.join(', ')} WHERE id = $${idx} AND entity_type = 'plan' AND entity_id = $${idx + 1} RETURNING *`,
      params
    );

    if (result.length === 0) {
      return reply.code(404).send({ error: 'Comment not found' });
    }

    return { comment: result[0] };
  });

  // DELETE /api/plans/:id/comments/:commentId - Delete a comment
  fastify.delete<{
    Params: { id: string; commentId: string };
  }>('/:id/comments/:commentId', async (request, reply) => {
    const { id, commentId } = request.params;

    const result = await query(
      "DELETE FROM comments WHERE id = $1 AND entity_type = 'plan' AND entity_id = $2 RETURNING id",
      [commentId, id]
    );

    if (result.length === 0) {
      return reply.code(404).send({ error: 'Comment not found' });
    }

    return reply.code(204).send();
  });

  // DELETE /api/plans/:id/comments - Bulk delete comments
  fastify.delete<{
    Params: { id: string };
    Querystring: { status?: string; confirm?: string };
  }>('/:id/comments', async (request, reply) => {
    const { id } = request.params;
    const { status, confirm } = request.query;

    const plan = await querySingle('SELECT id FROM plans WHERE id = $1', [id]);
    if (!plan) {
      return reply.code(404).send({ error: 'Plan not found' });
    }

    if (!status && confirm !== 'true') {
      return reply.code(400).send({ error: 'status is required unless confirm=true' });
    }
    if (status && !VALID_STATUSES.includes(status)) {
      return reply.code(400).send({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const conditions = ["entity_type = 'plan'", 'entity_id = $1'];
    const params: any[] = [id];
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

  // GET /api/plans/:id/export - Export plan content
  fastify.get<{
    Params: { id: string };
    Querystring: { format?: string };
  }>('/:id/export', async (request, reply) => {
    const { id } = request.params;
    const { format } = request.query;

    if (!format || !VALID_EXPORT_FORMATS.includes(format as ExportFormat)) {
      return reply.code(400).send({
        error: `format query parameter required. Must be one of: ${VALID_EXPORT_FORMATS.join(', ')}`,
      });
    }

    // Get plan with current version
    const plan = await querySingle<Plan & { project_name: string | null }>(
      `SELECT
         p.id,
         p.filename,
         p.file_path,
         pv.title,
         pv.content,
         p.current_version,
         p.status,
         p.project_id,
         proj.display_name as project_name,
         p.created_at,
         p.updated_at
       FROM plans p
       JOIN plan_versions pv ON pv.plan_id = p.id AND pv.version = p.current_version
       LEFT JOIN projects proj ON p.project_id = proj.id
       WHERE p.id = $1`,
      [id]
    );

    if (!plan) {
      return reply.code(404).send({ error: 'Plan not found' });
    }

    // Build frontmatter for markdown export
    const frontmatter = [
      '---',
      `title: "${plan.title?.replace(/"/g, '\\"') || 'Untitled Plan'}"`,
      `status: ${plan.status}`,
      ...(plan.project_name ? [`project: "${plan.project_name}"`] : []),
      `created_at: ${plan.created_at.toISOString()}`,
      `updated_at: ${plan.updated_at.toISOString()}`,
      '---',
      '',
    ].join('\n');

    const filename = plan.filename?.replace(/\.md$/, '') || 'plan';

    switch (format as ExportFormat) {
      case 'markdown': {
        const md = frontmatter + (plan.content || '');
        return reply
          .header('Content-Type', 'text/markdown; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="${filename}.md"`)
          .send(md);
      }
      case 'slack': {
        const slackText = markdownToSlack(plan.content || '');
        return reply.header('Content-Type', 'text/plain; charset=utf-8').send(slackText);
      }
      case 'docx': {
        const buffer = await planToDocx({
          title: plan.title || 'Untitled Plan',
          content: plan.content || '',
          status: plan.status,
          project_name: plan.project_name || undefined,
          created_at: plan.created_at,
          updated_at: plan.updated_at,
        });
        return reply
          .header(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          )
          .header('Content-Disposition', `attachment; filename="${filename}.docx"`)
          .header('X-Download-Options', 'noopen')
          .send(buffer);
      }
    }
  });
};

export default planRoutes;
