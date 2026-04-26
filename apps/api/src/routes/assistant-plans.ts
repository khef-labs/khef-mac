import { FastifyPluginAsync } from 'fastify';
import { query } from '../db/client';
import {
  listPlans,
  getPlan,
  deletePlan,
  getPlansPath,
  getPlanVersions,
  getPlanVersion,
  updatePlan,
} from '../services/plans';

const assistantPlanRoutes: FastifyPluginAsync = async (fastify) => {
  // Shared validation: verify assistant exists and supports plans
  async function validateAssistant(
    handle: string
  ): Promise<{ valid: boolean; error?: string; status?: number }> {
    const assistants = await query<{ id: string }>(
      'SELECT id FROM assistants WHERE handle = $1',
      [handle]
    );
    if (assistants.length === 0) {
      return { valid: false, error: 'Assistant not found', status: 404 };
    }
    if (!getPlansPath(handle)) {
      return {
        valid: false,
        error: `Assistant '${handle}' does not support plans`,
        status: 400,
      };
    }
    return { valid: true };
  }

  // GET / — List all plans (auto-discovers from disk)
  fastify.get<{
    Params: { handle: string };
    Querystring: { sort?: string; order?: string; limit?: string; offset?: string };
  }>('/', async (request, reply) => {
    const { handle } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
    const offset = request.query.offset ? parseInt(request.query.offset, 10) : undefined;

    const result = await listPlans(handle, {
      sort: (request.query.sort as 'date' | 'name') ?? 'date',
      order: (request.query.order as 'asc' | 'desc') ?? 'desc',
      limit,
      offset,
    });
    return result;
  });

  // GET /:filename — Get a specific plan (current version)
  fastify.get<{
    Params: { handle: string; filename: string };
  }>('/:filename', async (request, reply) => {
    const { handle, filename } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    const plan = await getPlan(handle, filename);
    if (!plan) {
      return reply.code(404).send({ error: 'Plan not found' });
    }

    return { plan };
  });

  // GET /:filename/versions — List all versions of a plan
  fastify.get<{
    Params: { handle: string; filename: string };
  }>('/:filename/versions', async (request, reply) => {
    const { handle, filename } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    const result = await getPlanVersions(handle, filename);
    if (!result) {
      return reply.code(404).send({ error: 'Plan not found' });
    }

    return result;
  });

  // GET /:filename/versions/:version — Get a specific version
  fastify.get<{
    Params: { handle: string; filename: string; version: string };
  }>('/:filename/versions/:version', async (request, reply) => {
    const { handle, filename, version: versionStr } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    const version = parseInt(versionStr, 10);
    if (isNaN(version) || version < 1) {
      return reply.code(400).send({ error: 'Invalid version number' });
    }

    const planVersion = await getPlanVersion(handle, filename, version);
    if (!planVersion) {
      return reply.code(404).send({ error: 'Version not found' });
    }

    return { version: planVersion };
  });

  // DELETE /:filename/versions/:version — Delete a specific version
  fastify.delete<{
    Params: { handle: string; filename: string; version: string };
  }>('/:filename/versions/:version', async (request, reply) => {
    const { handle, filename, version: versionStr } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    const version = parseInt(versionStr, 10);
    if (isNaN(version) || version < 1) {
      return reply.code(400).send({ error: 'Invalid version number' });
    }

    const { deletePlanVersion } = await import('../services/plans.js');
    const result = await deletePlanVersion(handle, filename, version);

    if (!result.deleted) {
      const status = result.error === 'Version not found' ? 404 : 400;
      return reply.code(status).send({ error: result.error });
    }

    return reply.code(204).send();
  });

  // PATCH /:filename — Update plan metadata (status, project_id)
  fastify.patch<{
    Params: { handle: string; filename: string };
    Body: { status?: string; project_id?: string | null };
  }>('/:filename', async (request, reply) => {
    const { handle, filename } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    const { status, project_id } = request.body ?? {};

    // Validate status if provided
    if (status !== undefined) {
      const validStatuses = ['active', 'archived', 'completed', 'abandoned'];
      if (!validStatuses.includes(status)) {
        return reply.code(400).send({
          error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
        });
      }
    }

    // Validate project_id if provided (not null)
    if (project_id !== undefined && project_id !== null) {
      const projects = await query<{ id: string }>(
        'SELECT id FROM projects WHERE id = $1',
        [project_id]
      );
      if (projects.length === 0) {
        return reply.code(400).send({ error: 'Project not found' });
      }
    }

    const plan = await updatePlan(handle, filename, { status, project_id });
    if (!plan) {
      return reply.code(404).send({ error: 'Plan not found' });
    }

    return { plan };
  });

  // DELETE /:filename — Delete a plan (from disk if exists, and from DB)
  fastify.delete<{
    Params: { handle: string; filename: string };
  }>('/:filename', async (request, reply) => {
    const { handle, filename } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    const result = await deletePlan(handle, filename);
    if (!result.success) {
      const status = result.error === 'Plan not found' ? 404 : 400;
      return reply.code(status).send({ error: result.error });
    }

    return { success: true };
  });
};

export default assistantPlanRoutes;
