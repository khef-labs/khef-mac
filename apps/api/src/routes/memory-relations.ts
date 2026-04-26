import { FastifyPluginAsync } from 'fastify';
import { query } from '../db/client';
import { MemoryRelation } from '../types';
import { generateExcerpt } from '../utils/excerpt';
import { formatMemoryGraph } from '../utils/graph-formatter';

const memoryRelationsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/memories/:memoryId/relations - Get memory relations (flat format)
  // Returns a flat array with contextual relation_type (forward when source, inverse when target)
  fastify.get('/', async (request) => {
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
         rmt_parent.name AS related_memory_parent_type,
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
       LEFT JOIN memory_types rmt_parent ON rmt.parent_id = rmt_parent.id
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
        parent_type: r.related_memory_parent_type || undefined,
        status: r.related_memory_status,
        project_id: r.related_memory_project_id,
        project_handle: r.related_memory_project_handle,
        project_name: r.related_memory_project_name
      }
    }));

    return { relations: formattedRelations };
  });

  // GET /api/memories/:memoryId/relations/graph - Get memory graph
  fastify.get('/graph', async (request, reply) => {
    const { memoryId } = request.params as { memoryId: string };
    const { depth = 2, compact = 'true', max_nodes = '200', max_edges = '400', format = 'json' } = request.query as { depth?: number; compact?: string; max_nodes?: string; max_edges?: string; format?: string };
    const maxNodes = Math.max(1, parseInt(String(max_nodes), 10) || 200);
    const maxEdges = Math.max(1, parseInt(String(max_edges), 10) || 400);

    const result = await query(
      `WITH RECURSIVE memory_graph AS (
        -- Base case: the starting memory
        SELECT m.id, m.project_id, m.content, mt.name as type, mt_parent.name as parent_type, mts.status_value as status, m.created_at, m.updated_at, 0 as depth
        FROM memories m
        INNER JOIN memory_types mt ON m.memory_type_id = mt.id
        LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
        INNER JOIN memory_type_statuses mts ON m.status_id = mts.id
        WHERE m.id = $1

        UNION

        -- Recursive case: traverse both outgoing and incoming relations
        SELECT m.id, m.project_id, m.content, mt.name as type, mt_parent.name as parent_type, mts.status_value as status, m.created_at, m.updated_at, mg.depth + 1
        FROM memory_graph mg
        INNER JOIN memory_relations mr ON mr.source_memory_id = mg.id OR mr.target_memory_id = mg.id
        INNER JOIN memories m ON (
          (mr.source_memory_id = mg.id AND m.id = mr.target_memory_id) OR
          (mr.target_memory_id = mg.id AND m.id = mr.source_memory_id)
        )
        INNER JOIN memory_types mt ON m.memory_type_id = mt.id
        LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
        INNER JOIN memory_type_statuses mts ON m.status_id = mts.id
        WHERE mg.depth < $2
      )
      SELECT DISTINCT mg.id, mg.project_id, m.handle, m.title, mg.content, mg.type, mg.parent_type, mg.status, mg.created_at, mg.updated_at, p.handle as project_handle, p.display_name as project_name, mg.depth
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
    const max_depth = result.reduce((max: number, n: any) => Math.max(max, n.depth ?? 0), 0);

    if (format === 'text') {
      const textNodes = result.map((n: any) => ({
        id: n.id,
        title: n.title,
        type: n.type,
        parent_type: n.parent_type || undefined,
        status: n.status,
        depth: n.depth,
      }));
      const textEdges = relations.map((r: any) => ({
        source: r.source_memory_id,
        target: r.target_memory_id,
        relation_type: r.relation_type,
      }));
      const text = formatMemoryGraph(textNodes, textEdges, memoryId);
      return reply.type('text/plain').send(text);
    }

    if (isCompact) {
      const nodes = result.map((n: any) => ({
        id: n.id,
        project_id: n.project_id,
        project_handle: n.project_handle,
        project_name: n.project_name,
        handle: n.handle,
        title: n.title,
        type: n.type,
        parent_type: n.parent_type || undefined,
        status: n.status,
        updated_at: n.updated_at,
        content_excerpt: generateExcerpt(n.content)
      }));
      const truncated = { nodes: nodes.length >= maxNodes, edges: relations.length >= maxEdges };
      return { nodes, edges: relations, truncated, max_depth };
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
      parent_type: n.parent_type || undefined,
      status: n.status,
      created_at: n.created_at,
      updated_at: n.updated_at,
      depth: n.depth
    }));

    const truncated = { nodes: nodes.length >= maxNodes, edges: relations.length >= maxEdges };
    return { nodes, edges: relations, truncated, max_depth };
  });
};

export default memoryRelationsRoutes;
