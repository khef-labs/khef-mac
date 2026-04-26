import { FastifyPluginAsync } from 'fastify';
import { query } from '../db/client';
import { resolveProject } from './projects';
import {
  getKnowledgeAggregateSize,
  getRulesAggregateSize,
} from '../services/knowledge-validation';

interface MemoryTypeCount {
  type: string;
  count: number;
}

interface StatusCount {
  status: string;
  count: number;
}

const projectStatsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/projects/:projectId/stats - Get project statistics
  fastify.get('/', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Memory counts by type
    const byType = await query<MemoryTypeCount>(
      `SELECT mt.name as type, COUNT(m.id)::int as count
       FROM memory_types mt
       LEFT JOIN memories m ON m.memory_type_id = mt.id AND m.project_id = $1
       GROUP BY mt.name
       ORDER BY count DESC`,
      [project.id]
    );

    // Memory counts by status
    const byStatus = await query<StatusCount>(
      `SELECT mts.status_value as status, COUNT(m.id)::int as count
       FROM memories m
       JOIN memory_type_statuses mts ON m.status_id = mts.id
       WHERE m.project_id = $1
       GROUP BY mts.status_value
       ORDER BY count DESC`,
      [project.id]
    );

    // Total memories
    const totalResult = await query<{ count: number }>(
      'SELECT COUNT(*)::int as count FROM memories WHERE project_id = $1',
      [project.id]
    );

    // Sync sizes
    const knowledge = await getKnowledgeAggregateSize(project.id);
    const rules = await getRulesAggregateSize(project.id);

    return {
      project_id: project.id,
      project_handle: project.handle,
      memories: {
        total: totalResult[0].count,
        by_type: byType.filter((t) => t.count > 0),
        by_status: byStatus,
      },
      sync: {
        knowledge: {
          estimated_size: knowledge.estimated_output_size,
          split_threshold: knowledge.split_threshold,
          estimated_file_count: knowledge.estimated_file_count,
        },
        rules: {
          estimated_size: rules.estimated_output_size,
          split_threshold: rules.split_threshold,
          estimated_file_count: rules.estimated_file_count,
        },
      },
    };
  });
};

export default projectStatsRoutes;
