/**
 * kapi routes — built-in API tool, scoped to kapi.collections (independent
 * of public.projects). Mounted at /api/kapi.
 *
 * Collection-scoped lists/creates: /api/kapi/collections/:collectionId/...
 * Id-scoped reads/updates/deletes:  /api/kapi/{definitions,requests,scripts,environments,runs}/:id
 */

import { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  KapiError,
  createDefinition,
  deleteDefinition,
  getDefinitionById,
  listDefinitions,
  updateDefinition,
  type CreateDefinitionInput,
  type UpdateDefinitionInput,
} from '../services/kapi/definitions';
import {
  createCollection,
  deleteCollection,
  getCollectionById,
  listCollections,
  resolveCollection,
  updateCollection,
  type CreateCollectionInput,
  type UpdateCollectionInput,
} from '../services/kapi/collections';
import {
  createRequest,
  deleteRequest,
  getRequestById,
  listRequests,
  updateRequest,
  type CreateRequestInput,
  type UpdateRequestInput,
} from '../services/kapi/requests';
import {
  activateEnvironment,
  createEnvironment,
  deleteEnvVar,
  deleteEnvironment,
  getEnvironmentById,
  listEnvVars,
  listEnvironments,
  renameEnvVar,
  updateEnvironment,
  upsertEnvVar,
  type CreateEnvironmentInput,
  type UpdateEnvironmentInput,
  type UpsertEnvVarInput,
} from '../services/kapi/environments';
import {
  getRun,
  listRuns,
  runAdHoc,
  runSavedRequest,
  type AdHocRunInput,
} from '../services/kapi/runner';

function handleError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof KapiError) {
    return reply.status(err.statusCode).send({ error: err.message });
  }
  throw err;
}

/**
 * All kapi routes mount under a single prefix: /api/kapi.
 */
const kapiRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // ---------- Collections ----------
  fastify.get('/collections', async (_request, reply) => {
    try {
      return { collections: await listCollections() };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  fastify.post<{ Body: CreateCollectionInput }>('/collections', async (request, reply) => {
    try {
      const collection = await createCollection(request.body);
      return reply.status(201).send({ collection });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  fastify.get<{ Params: { id: string } }>('/collections/:id', async (request, reply) => {
    try {
      const collection = await resolveCollection(request.params.id);
      if (!collection) return reply.status(404).send({ error: 'Collection not found' });
      return { collection };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  fastify.patch<{ Params: { id: string }; Body: UpdateCollectionInput }>(
    '/collections/:id',
    async (request, reply) => {
      try {
        const target = await resolveCollection(request.params.id);
        if (!target) return reply.status(404).send({ error: 'Collection not found' });
        const collection = await updateCollection(target.id, request.body);
        return { collection };
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  fastify.delete<{ Params: { id: string } }>('/collections/:id', async (request, reply) => {
    try {
      const target = await resolveCollection(request.params.id);
      if (!target) return reply.status(404).send({ error: 'Collection not found' });
      await deleteCollection(target.id);
      return reply.status(204).send();
    } catch (err) {
      return handleError(err, reply);
    }
  });

  // ---------- Collection-scoped: definitions ----------
  fastify.get<{ Params: { id: string } }>(
    '/collections/:id/definitions',
    async (request, reply) => {
      try {
        const collection = await resolveCollection(request.params.id);
        if (!collection) return reply.status(404).send({ error: 'Collection not found' });
        return { definitions: await listDefinitions(collection.id) };
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  fastify.post<{
    Params: { id: string };
    Body: Omit<CreateDefinitionInput, 'collection_id'>;
  }>('/collections/:id/definitions', async (request, reply) => {
    try {
      const collection = await resolveCollection(request.params.id);
      if (!collection) return reply.status(404).send({ error: 'Collection not found' });
      const definition = await createDefinition({
        ...request.body,
        collection_id: collection.id,
      });
      return reply.status(201).send({ definition });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  // ---------- Collection-scoped: environments ----------
  fastify.get<{ Params: { id: string } }>(
    '/collections/:id/environments',
    async (request, reply) => {
      try {
        const collection = await resolveCollection(request.params.id);
        if (!collection) return reply.status(404).send({ error: 'Collection not found' });
        return { environments: await listEnvironments(collection.id) };
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  fastify.post<{
    Params: { id: string };
    Body: Omit<CreateEnvironmentInput, 'collection_id'>;
  }>('/collections/:id/environments', async (request, reply) => {
    try {
      const collection = await resolveCollection(request.params.id);
      if (!collection) return reply.status(404).send({ error: 'Collection not found' });
      const environment = await createEnvironment({
        ...request.body,
        collection_id: collection.id,
      });
      return reply.status(201).send({ environment });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  // ---------- Collection-scoped: runs (ad-hoc + history) ----------
  fastify.post<{
    Params: { id: string };
    Body: Omit<AdHocRunInput, 'collection_id'>;
  }>('/collections/:id/runs', async (request, reply) => {
    const controller = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) controller.abort();
    });
    try {
      const collection = await resolveCollection(request.params.id);
      if (!collection) return reply.status(404).send({ error: 'Collection not found' });
      const run = await runAdHoc({
        ...request.body,
        collection_id: collection.id,
        options: { ...(request.body?.options ?? {}), signal: controller.signal },
      });
      return reply.status(201).send({ run });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  fastify.get<{
    Params: { id: string };
    Querystring: { request_id?: string; limit?: string };
  }>('/collections/:id/runs', async (request, reply) => {
    try {
      const collection = await resolveCollection(request.params.id);
      if (!collection) return reply.status(404).send({ error: 'Collection not found' });
      const runs = await listRuns(collection.id, {
        request_id: request.query.request_id,
        limit: request.query.limit ? parseInt(request.query.limit, 10) : undefined,
      });
      return { runs };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  // ---------- Definitions (id-scoped) ----------
  fastify.get<{ Params: { id: string } }>('/definitions/:id', async (request, reply) => {
    try {
      const definition = await getDefinitionById(request.params.id);
      if (!definition) return reply.status(404).send({ error: 'Definition not found' });
      return { definition };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  fastify.patch<{ Params: { id: string }; Body: UpdateDefinitionInput }>(
    '/definitions/:id',
    async (request, reply) => {
      try {
        const definition = await updateDefinition(request.params.id, request.body);
        return { definition };
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  fastify.delete<{ Params: { id: string } }>('/definitions/:id', async (request, reply) => {
    try {
      await deleteDefinition(request.params.id);
      return reply.status(204).send();
    } catch (err) {
      return handleError(err, reply);
    }
  });

  // ---------- Requests (nested under definition) ----------
  fastify.get<{ Params: { id: string } }>(
    '/definitions/:id/requests',
    async (request, reply) => {
      try {
        const definition = await getDefinitionById(request.params.id);
        if (!definition) return reply.status(404).send({ error: 'Definition not found' });
        return { requests: await listRequests(definition.id) };
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  fastify.post<{
    Params: { id: string };
    Body: Omit<CreateRequestInput, 'definition_id'>;
  }>('/definitions/:id/requests', async (request, reply) => {
    try {
      const definition = await getDefinitionById(request.params.id);
      if (!definition) return reply.status(404).send({ error: 'Definition not found' });
      const created = await createRequest({ ...request.body, definition_id: definition.id });
      return reply.status(201).send({ request: created });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  fastify.get<{ Params: { id: string } }>('/requests/:id', async (request, reply) => {
    try {
      const req = await getRequestById(request.params.id);
      if (!req) return reply.status(404).send({ error: 'Request not found' });
      return { request: req };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  fastify.patch<{ Params: { id: string }; Body: UpdateRequestInput }>(
    '/requests/:id',
    async (request, reply) => {
      try {
        const updated = await updateRequest(request.params.id, request.body);
        return { request: updated };
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  fastify.delete<{ Params: { id: string } }>('/requests/:id', async (request, reply) => {
    try {
      await deleteRequest(request.params.id);
      return reply.status(204).send();
    } catch (err) {
      return handleError(err, reply);
    }
  });

  // ---------- Environments (id-scoped) ----------
  fastify.get<{ Params: { id: string } }>('/environments/:id', async (request, reply) => {
    try {
      const env = await getEnvironmentById(request.params.id);
      if (!env) return reply.status(404).send({ error: 'Environment not found' });
      return { environment: env };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  fastify.patch<{ Params: { id: string }; Body: UpdateEnvironmentInput }>(
    '/environments/:id',
    async (request, reply) => {
      try {
        const environment = await updateEnvironment(request.params.id, request.body);
        return { environment };
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  fastify.delete<{ Params: { id: string } }>('/environments/:id', async (request, reply) => {
    try {
      await deleteEnvironment(request.params.id);
      return reply.status(204).send();
    } catch (err) {
      return handleError(err, reply);
    }
  });

  fastify.post<{ Params: { id: string } }>(
    '/environments/:id/activate',
    async (request, reply) => {
      try {
        const environment = await activateEnvironment(request.params.id);
        return { environment };
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  // Env vars
  fastify.get<{ Params: { id: string } }>(
    '/environments/:id/vars',
    async (request, reply) => {
      try {
        const env = await getEnvironmentById(request.params.id);
        if (!env) return reply.status(404).send({ error: 'Environment not found' });
        return { vars: await listEnvVars(env.id) };
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  fastify.post<{ Params: { id: string }; Body: UpsertEnvVarInput }>(
    '/environments/:id/vars',
    async (request, reply) => {
      try {
        const env = await getEnvironmentById(request.params.id);
        if (!env) return reply.status(404).send({ error: 'Environment not found' });
        const envVar = await upsertEnvVar(env.id, request.body);
        return reply.status(201).send({ var: envVar });
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  fastify.delete<{ Params: { id: string; key: string } }>(
    '/environments/:id/vars/:key',
    async (request, reply) => {
      try {
        await deleteEnvVar(request.params.id, request.params.key);
        return reply.status(204).send();
      } catch (err) {
        return handleError(err, reply);
      }
    }
  );

  fastify.patch<{
    Params: { id: string; key: string };
    Body: { new_key: string };
  }>('/environments/:id/vars/:key/rename', async (request, reply) => {
    try {
      const envVar = await renameEnvVar(
        request.params.id,
        request.params.key,
        request.body?.new_key
      );
      return { var: envVar };
    } catch (err) {
      return handleError(err, reply);
    }
  });

  // ---------- Runner ----------
  fastify.post<{
    Params: { id: string };
    Body: { allow_insecure_tls?: boolean; max_redirects?: number; timeout_ms?: number };
  }>('/requests/:id/run', async (request, reply) => {
    // Abort any in-flight upstream call (and sandbox fetches) when the
    // client disconnects. We listen on reply.raw (ServerResponse), not
    // request.raw — request.raw.close fires at normal end-of-request too.
    // writableEnded is false when the socket dies before reply.send().
    const controller = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) controller.abort();
    });
    try {
      const run = await runSavedRequest(request.params.id, {
        ...(request.body ?? {}),
        signal: controller.signal,
      });
      return reply.status(201).send({ run });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  fastify.get<{ Params: { id: string } }>('/runs/:id', async (request, reply) => {
    try {
      const run = await getRun(request.params.id);
      if (!run) return reply.status(404).send({ error: 'Run not found' });
      return { run };
    } catch (err) {
      return handleError(err, reply);
    }
  });
};

export default kapiRoutes;
