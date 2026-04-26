import { FastifyPluginAsync } from 'fastify';
import { buildSessionContextByProjectId, resolveProject } from './projects';

type InitializeSessionQuery = {
  project_id?: string;
  project_handle?: string;
  project_name?: string;
};

const sessionRoutes: FastifyPluginAsync = async (fastify) => {
  // GET variant: accepts project_id, project_handle, or project_name as query params
  fastify.get('/initialize_session', async (request, reply) => {
    const { project_id, project_handle, project_name } = (request.query || {}) as InitializeSessionQuery;

    const identifier = (project_id || project_handle || project_name || '').trim();
    if (!identifier) {
      return reply.code(400).send({ error: 'One of project_id, project_handle, or project_name is required' });
    }

    const project = await resolveProject(identifier);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const ctx = await buildSessionContextByProjectId(project.id);
    return ctx;
  });
};

export default sessionRoutes;
