import { FastifyPluginAsync } from 'fastify';
import { query } from '../db/client';
import { Tag, Memory, TagRef } from '../types';
import { normalizeTag, isValidTag } from '../utils/tags';

const tagRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request) => {
    const { q } = request.query as { q?: string };
    let sql = 'SELECT * FROM tags';
    const params: any[] = [];
    if (q && q.trim()) {
      sql += ' WHERE LOWER(name) LIKE LOWER($1)';
      params.push(`%${q}%`);
    }
    sql += ' ORDER BY name ASC';
    const tags = await query<Tag>(sql, params);
    return { tags };
  });

  fastify.get('/:name/memories', async (request, reply) => {
    const { name } = request.params as { name: string };

    const memories = await query<Memory & { type: string; status?: string }>(
      `SELECT m.id, m.project_id, m.handle, m.title, m.content, m.memory_type_id, m.status_id,
              m.status_updated_at, m.created_at, m.updated_at,
              mt.name as type, mts.status_value as status
       FROM memories m
       INNER JOIN memory_types mt ON m.memory_type_id = mt.id
       LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
       INNER JOIN memory_tags mtag ON m.id = mtag.memory_id
       INNER JOIN tags t ON mtag.tag_id = t.id
       WHERE t.name = $1
       ORDER BY m.created_at DESC`,
      [name]
    );

    // Fetch tags for all memories in one query
    const memoryIds = memories.map(m => m.id);
    const tagsMap = new Map<string, TagRef[]>();

    if (memoryIds.length > 0) {
      const tagResults = await query<{ memory_id: string; tag_id: string; tag_name: string }>(
        `SELECT mtag.memory_id, t.id as tag_id, t.name as tag_name
         FROM memory_tags mtag
         INNER JOIN tags t ON mtag.tag_id = t.id
         WHERE mtag.memory_id = ANY($1)`,
        [memoryIds]
      );

      for (const { memory_id, tag_id, tag_name } of tagResults) {
        if (!tagsMap.has(memory_id)) {
          tagsMap.set(memory_id, []);
        }
        tagsMap.get(memory_id)!.push({ id: tag_id, name: tag_name });
      }
    }

    const memoriesWithTags = memories.map(memory => ({
      ...memory,
      tags: tagsMap.get(memory.id) || []
    }));

    return { memories: memoriesWithTags };
  });

  fastify.post('/', async (request, reply) => {
    const { name } = request.body as { name: string };

    if (!name || !name.trim()) {
      return reply.code(400).send({ error: 'Tag name is required' });
    }

    const trimmedName = normalizeTag(name);

    if (!isValidTag(trimmedName)) {
      return reply.code(400).send({ error: 'Invalid tag name. Use 2-100 lowercase alphanumeric characters, hyphens, dots, or slashes.' });
    }

    // Check if tag already exists
    const existing = await query<Tag>(
      'SELECT * FROM tags WHERE name = $1',
      [trimmedName]
    );

    if (existing.length > 0) {
      return reply.code(409).send({ error: 'Tag already exists' });
    }

    const tags = await query<Tag>(
      'INSERT INTO tags (name) VALUES ($1) RETURNING *',
      [trimmedName]
    );

    return reply.code(201).send({ tag: tags[0] });
  });

  fastify.patch('/:tagId', async (request, reply) => {
    const { tagId } = request.params as { tagId: string };
    const { name } = request.body as { name: string };

    if (!name || !name.trim()) {
      return reply.code(400).send({ error: 'Tag name is required' });
    }

    const trimmedName = normalizeTag(name);

    if (!isValidTag(trimmedName)) {
      return reply.code(400).send({ error: 'Invalid tag name. Use 2-100 lowercase alphanumeric characters, hyphens, dots, or slashes.' });
    }

    // Check if new name already exists
    const existing = await query<Tag>(
      'SELECT * FROM tags WHERE name = $1 AND id != $2',
      [trimmedName, tagId]
    );

    if (existing.length > 0) {
      return reply.code(409).send({ error: 'Tag name already exists' });
    }

    const tags = await query<Tag>(
      'UPDATE tags SET name = $1 WHERE id = $2 RETURNING *',
      [trimmedName, tagId]
    );

    if (tags.length === 0) {
      return reply.code(404).send({ error: 'Tag not found' });
    }

    return { tag: tags[0] };
  });

  fastify.delete('/:tagId', async (request, reply) => {
    const { tagId } = request.params as { tagId: string };

    // Check if tag is in use
    const usage = await query(
      'SELECT COUNT(*) as count FROM memory_tags WHERE tag_id = $1',
      [tagId]
    );

    if (parseInt(usage[0].count) > 0) {
      return reply.code(409).send({
        error: 'Cannot delete tag that is in use',
        usage_count: parseInt(usage[0].count)
      });
    }

    const result = await query(
      'DELETE FROM tags WHERE id = $1 RETURNING id',
      [tagId]
    );

    if (result.length === 0) {
      return reply.code(404).send({ error: 'Tag not found' });
    }

    return reply.code(204).send();
  });
};

export default tagRoutes;
