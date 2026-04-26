/**
 * Routes for kvec auto-embed configuration.
 * Manages per-repo per-branch scheduled commit embedding.
 */

import { FastifyPluginAsync } from 'fastify';
import type { AutoEmbedJobType } from '../services/kvec-auto-embed';
import {
  listAutoEmbedConfigs,
  getAutoEmbedConfig,
  createAutoEmbedConfig,
  updateAutoEmbedConfig,
  deleteAutoEmbedConfig,
  runAutoEmbedTick,
} from '../services/kvec-auto-embed';

const kvecAutoEmbedRoutes: FastifyPluginAsync = async (fastify) => {
  // GET / — list all auto-embed configs
  fastify.get('/', async () => {
    const configs = await listAutoEmbedConfigs();
    return { configs };
  });

  // POST / — create a new auto-embed config
  fastify.post<{
    Body: { repo_path: string; branch?: string; job_type?: string; batch_delay_ms?: number };
  }>('/', async (request, reply) => {
    const { repo_path, branch, job_type, batch_delay_ms } = request.body ?? {} as any;

    if (!repo_path || typeof repo_path !== 'string') {
      return reply.status(400).send({ error: 'repo_path is required' });
    }

    if (job_type && job_type !== 'commits' && job_type !== 'source') {
      return reply.status(400).send({ error: 'job_type must be "commits" or "source"' });
    }

    try {
      const config = await createAutoEmbedConfig({ repo_path, branch, job_type: job_type as AutoEmbedJobType, batch_delay_ms });
      return reply.status(201).send({ config });
    } catch (err: any) {
      if (err.code === '23505') {
        return reply.status(409).send({ error: 'Auto-embed config already exists for this repo + branch' });
      }
      return reply.status(400).send({ error: err.message });
    }
  });

  // PATCH /:id — update an auto-embed config
  fastify.patch<{
    Params: { id: string };
    Body: { enabled?: boolean; batch_delay_ms?: number; branch?: string };
  }>('/:id', async (request, reply) => {
    const config = await updateAutoEmbedConfig(request.params.id, request.body ?? {});
    if (!config) {
      return reply.status(404).send({ error: 'Config not found' });
    }
    return { config };
  });

  // DELETE /:id — delete an auto-embed config
  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const deleted = await deleteAutoEmbedConfig(request.params.id);
    if (!deleted) {
      return reply.status(404).send({ error: 'Config not found' });
    }
    return reply.status(204).send();
  });

  // POST /run — manually trigger a scheduler tick
  fastify.post('/run', async () => {
    const result = await runAutoEmbedTick();
    return result;
  });
};

export default kvecAutoEmbedRoutes;
