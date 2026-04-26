import { FastifyPluginAsync } from 'fastify';
import { resolveProject } from './projects';
import { listPlansByProject } from '../services/plans';

/**
 * Project-scoped plan routes
 * Base path: /api/projects/:projectId/plans
 */
const projectPlansRoutes: FastifyPluginAsync = async (fastify) => {
  // GET / — List plans for a project
  fastify.get<{
    Params: { projectId: string };
    Querystring: { sort?: 'date' | 'name'; order?: 'asc' | 'desc'; limit?: string; offset?: string };
  }>('/', async (request, reply) => {
    const { projectId } = request.params;
    const { sort, order } = request.query;

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
    const offset = request.query.offset ? parseInt(request.query.offset, 10) : undefined;

    const result = await listPlansByProject(project.id, { sort, order, limit, offset });
    return result;
  });
};

export default projectPlansRoutes;
