import { FastifyPluginAsync } from 'fastify';
import { querySingle } from '../db/client';
import { Comment } from '../types';

/**
 * Global comment routes - /api/comments
 * For fetching comments by ID without knowing the parent entity
 */
const globalCommentRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/comments/:id - Get a comment by ID
  fastify.get<{
    Params: { id: string };
  }>('/:id', async (request, reply) => {
    const { id } = request.params;

    const comment = await querySingle<Comment>(
      `SELECT
         id, entity_type, entity_id, content, author, updated_by,
         parent_comment_id, anchor_text, anchor_prefix, anchor_suffix,
         status, created_at, updated_at
       FROM comments
       WHERE id = $1`,
      [id]
    );

    if (!comment) {
      return reply.code(404).send({ error: 'Comment not found' });
    }

    return { comment };
  });
};

export default globalCommentRoutes;
