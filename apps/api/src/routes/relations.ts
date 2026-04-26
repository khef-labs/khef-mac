import { FastifyPluginAsync } from 'fastify';
import { query } from '../db/client';
import { CreateRelationInput, MemoryRelation } from '../types';
import { generateExcerpt } from '../utils/excerpt';

const relationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/', async (request, reply) => {
    const { source_memory_id, target_memory_id, relation_type } = request.body as CreateRelationInput;

    if (!source_memory_id || !target_memory_id || !relation_type) {
      return reply.code(400).send({ error: 'source_memory_id, target_memory_id, and relation_type are required' });
    }

    if (source_memory_id === target_memory_id) {
      return reply.code(400).send({ error: 'Cannot create relation to self' });
    }

    // Validate both memories exist
    const sourceMemory = await query(
      'SELECT project_id FROM memories WHERE id = $1',
      [source_memory_id]
    );

    const targetMemory = await query(
      'SELECT project_id FROM memories WHERE id = $1',
      [target_memory_id]
    );

    if (sourceMemory.length === 0 || targetMemory.length === 0) {
      return reply.code(404).send({ error: 'One or both memories not found' });
    }

    // Validate and resolve relation type (accept both forward and inverse values)
    const typeInfo = await query<{ value: string; inverse_value: string }>(
      'SELECT value, inverse_value FROM relation_types WHERE value = $1 OR inverse_value = $1',
      [relation_type]
    );

    if (typeInfo.length === 0) {
      const allTypes = await query<{ value: string; inverse_value: string }>(
        'SELECT value, inverse_value FROM relation_types'
      );
      const validValues = allTypes.flatMap(t => [t.value, t.inverse_value]);
      return reply.code(400).send({ error: `Invalid relation_type. Must be one of: ${validValues.join(', ')}` });
    }

    // Always store the forward (canonical) value
    const canonicalType = typeInfo[0].value;

    // Cross-project relations are allowed; DB trigger no longer enforces same-project

    const relations = await query<MemoryRelation>(
      `INSERT INTO memory_relations (source_memory_id, target_memory_id, relation_type)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [source_memory_id, target_memory_id, canonicalType]
    );

    return reply.code(201).send({ relation: relations[0] });
  });

  fastify.get('/memory/:memoryId', async (request) => {
    const { memoryId } = request.params as { memoryId: string };

    // Get all relations where this memory is involved, with contextual relation type
    const relations = await query(
      `SELECT
         mr.id,
         mr.created_at,
         -- Use forward relation type when this memory is source, inverse when target
         CASE
           WHEN mr.source_memory_id = $1 THEN rt.value
           ELSE rt.inverse_value
         END AS relation_type,
         CASE
           WHEN mr.source_memory_id = $1 THEN rt.forward_label
           ELSE rt.inverse_label
         END AS relation_label,
         -- Include the "other" memory as related_memory
         rm.id AS related_memory_id,
         rm.handle AS related_memory_handle,
         rm.title AS related_memory_title,
         rmt.name AS related_memory_type,
         rmts.status_value AS related_memory_status,
         rp.id AS related_memory_project_id,
         rp.handle AS related_memory_project_handle,
         rp.display_name AS related_memory_project_name
       FROM memory_relations mr
       INNER JOIN relation_types rt ON mr.relation_type = rt.value
       -- Join to the "related" memory (the one that isn't memoryId)
       INNER JOIN memories rm ON rm.id = CASE
         WHEN mr.source_memory_id = $1 THEN mr.target_memory_id
         ELSE mr.source_memory_id
       END
       INNER JOIN memory_types rmt ON rm.memory_type_id = rmt.id
       INNER JOIN memory_type_statuses rmts ON rm.status_id = rmts.id
       INNER JOIN projects rp ON rm.project_id = rp.id
       WHERE mr.source_memory_id = $1 OR mr.target_memory_id = $1
       ORDER BY mr.created_at DESC`,
      [memoryId]
    );

    // Transform to the desired shape
    const formattedRelations = relations.map((r: any) => ({
      id: r.id,
      relation_type: r.relation_type,
      relation_label: r.relation_label,
      created_at: r.created_at,
      related_memory: {
        id: r.related_memory_id,
        handle: r.related_memory_handle,
        title: r.related_memory_title,
        type: r.related_memory_type,
        status: r.related_memory_status,
        project_id: r.related_memory_project_id,
        project_handle: r.related_memory_project_handle,
        project_name: r.related_memory_project_name
      }
    }));

    return { relations: formattedRelations };
  });

  fastify.get('/memory/:memoryId/graph', async (request) => {
    const { memoryId } = request.params as { memoryId: string };
    const { depth = 2, compact = 'true', max_nodes = '200', max_edges = '400' } = request.query as { depth?: number; compact?: string; max_nodes?: string; max_edges?: string };
    const maxNodes = Math.max(1, parseInt(String(max_nodes), 10) || 200);
    const maxEdges = Math.max(1, parseInt(String(max_edges), 10) || 400);

    const result = await query(
      `WITH RECURSIVE memory_graph AS (
        -- Base case: the starting memory
        SELECT m.id, m.project_id, m.content, mt.name as type, mts.status_value as status, m.created_at, m.updated_at, 0 as depth
        FROM memories m
        INNER JOIN memory_types mt ON m.memory_type_id = mt.id
        INNER JOIN memory_type_statuses mts ON m.status_id = mts.id
        WHERE m.id = $1

        UNION

        -- Recursive case: traverse both outgoing and incoming relations
        SELECT m.id, m.project_id, m.content, mt.name as type, mts.status_value as status, m.created_at, m.updated_at, mg.depth + 1
        FROM memory_graph mg
        INNER JOIN memory_relations mr ON mr.source_memory_id = mg.id OR mr.target_memory_id = mg.id
        INNER JOIN memories m ON (
          (mr.source_memory_id = mg.id AND m.id = mr.target_memory_id) OR
          (mr.target_memory_id = mg.id AND m.id = mr.source_memory_id)
        )
        INNER JOIN memory_types mt ON m.memory_type_id = mt.id
        INNER JOIN memory_type_statuses mts ON m.status_id = mts.id
        WHERE mg.depth < $2
      )
      SELECT DISTINCT mg.id, mg.project_id, m.handle, m.title, mg.content, mg.type, mg.status, mg.created_at, mg.updated_at, p.handle as project_handle, p.display_name as project_name, mg.depth
      FROM memory_graph mg
      INNER JOIN memories m ON mg.id = m.id
      INNER JOIN projects p ON mg.project_id = p.id
      ORDER BY mg.depth
      LIMIT $3`,
      [memoryId, depth, maxNodes]
    );

    const relations = await query<MemoryRelation>(
      `WITH RECURSIVE memory_graph AS (
         SELECT m.id, 0 as depth
         FROM memories m
         WHERE m.id = $1

         UNION

         SELECT m.id, mg.depth + 1
         FROM memory_graph mg
         INNER JOIN memory_relations mr ON mr.source_memory_id = mg.id OR mr.target_memory_id = mg.id
         INNER JOIN memories m ON (
           (mr.source_memory_id = mg.id AND m.id = mr.target_memory_id) OR
           (mr.target_memory_id = mg.id AND m.id = mr.source_memory_id)
         )
         WHERE mg.depth < $2
       )
       SELECT DISTINCT mr.*
       FROM memory_relations mr
       WHERE mr.source_memory_id IN (SELECT id FROM memory_graph)
          OR mr.target_memory_id IN (SELECT id FROM memory_graph)
       LIMIT $3`,
      [memoryId, depth, maxEdges]
    );

    const isCompact = compact !== 'false';

    if (isCompact) {
      const nodes = result.map((n: any) => ({
        id: n.id,
        project_id: n.project_id,
        project_handle: n.project_handle,
        project_name: n.project_name,
        handle: n.handle,
        title: n.title,
        type: n.type,
        status: n.status,
        updated_at: n.updated_at,
        content_excerpt: generateExcerpt(n.content)
      }));
      const truncated = { nodes: nodes.length >= maxNodes, edges: relations.length >= maxEdges };
      return { nodes, edges: relations, truncated };
    }

    // Full mode: include content and depth; also include project metadata
    const nodes = result.map((n: any) => ({
      id: n.id,
      project_id: n.project_id,
      project_handle: n.project_handle,
      project_name: n.project_name,
      handle: n.handle,
      title: n.title,
      content: n.content,
      type: n.type,
      status: n.status,
      created_at: n.created_at,
      updated_at: n.updated_at,
      depth: n.depth
    }));

    const truncated = { nodes: nodes.length >= maxNodes, edges: relations.length >= maxEdges };
    return { nodes, edges: relations, truncated };
  });

  fastify.patch('/:relationId', async (request, reply) => {
    const { relationId } = request.params as { relationId: string };
    const { relation_type } = request.body as { relation_type?: string };

    if (!relation_type) {
      return reply.code(400).send({ error: 'relation_type is required' });
    }

    // Validate and resolve relation type (accept both forward and inverse values)
    const typeInfo = await query<{ value: string; inverse_value: string }>(
      'SELECT value, inverse_value FROM relation_types WHERE value = $1 OR inverse_value = $1',
      [relation_type]
    );

    if (typeInfo.length === 0) {
      const allTypes = await query<{ value: string; inverse_value: string }>(
        'SELECT value, inverse_value FROM relation_types'
      );
      const validValues = allTypes.flatMap(t => [t.value, t.inverse_value]);
      return reply.code(400).send({ error: `Invalid relation_type. Must be one of: ${validValues.join(', ')}` });
    }

    // Always store the forward (canonical) value
    const canonicalType = typeInfo[0].value;

    const result = await query<MemoryRelation>(
      'UPDATE memory_relations SET relation_type = $1 WHERE id = $2 RETURNING *',
      [canonicalType, relationId]
    );

    if (result.length === 0) {
      return reply.code(404).send({ error: 'Relation not found' });
    }

    return { relation: result[0] };
  });

  fastify.delete('/:relationId', async (request, reply) => {
    const { relationId } = request.params as { relationId: string };

    const result = await query(
      'DELETE FROM memory_relations WHERE id = $1 RETURNING id',
      [relationId]
    );

    if (result.length === 0) {
      return reply.code(404).send({ error: 'Relation not found' });
    }

    return reply.code(204).send();
  });
};

export default relationRoutes;
