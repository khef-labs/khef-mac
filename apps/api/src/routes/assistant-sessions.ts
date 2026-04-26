import { FastifyPluginAsync } from 'fastify';
import { query } from '../db/client';
import {
  listSessionProjects,
  listSessions,
  searchSessionContent,
  readSession,
  summarizeLoadedContext,
  deleteSession,
  bulkDeleteSessions,
  getSessionsBasePath,
  getSessionById,
  resolveProjectDir,
  ValidationError,
} from '../services/sessions';
import {
  syncSessionEmbeddings,
  getSessionEmbeddingStatus,
  searchSessions,
} from '../services/session-embeddings';

interface BaseQuery {
  _basePath?: string; // Override for testing
}

const assistantSessionRoutes: FastifyPluginAsync = async (fastify) => {
  // Shared validation: verify assistant exists and supports sessions
  async function validateAssistant(handle: string): Promise<{ valid: boolean; error?: string; status?: number }> {
    const assistants = await query<{ id: string }>(
      'SELECT id FROM assistants WHERE handle = $1',
      [handle]
    );
    if (assistants.length === 0) {
      return { valid: false, error: 'Assistant not found', status: 404 };
    }
    if (!getSessionsBasePath(handle)) {
      return { valid: false, error: `Assistant '${handle}' does not support session management`, status: 400 };
    }
    return { valid: true };
  }

  // GET / — List session project directories with stats
  fastify.get<{
    Params: { handle: string };
    Querystring: BaseQuery & { includeHidden?: string };
  }>('/', async (request, reply) => {
    const { handle } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    const result = await listSessionProjects(handle, request.query._basePath, {
      includeHidden: request.query.includeHidden === 'true',
    });
    return result;
  });

  // GET /:projectDir — List sessions in a project directory
  fastify.get<{
    Params: { handle: string; projectDir: string };
    Querystring: BaseQuery & { sort?: string; order?: string; limit?: string; offset?: string; ids_only?: string; q?: string };
  }>('/:projectDir', async (request, reply) => {
    const { handle, projectDir } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    try {
      const resolvedDir = await resolveProjectDir(projectDir);

      // When q is provided, search file content instead of listing
      if (request.query.q) {
        const result = await searchSessionContent(handle, resolvedDir, request.query.q, {
          sort: (request.query.sort as 'date' | 'size') ?? 'date',
          order: (request.query.order as 'asc' | 'desc') ?? 'desc',
          limit: request.query.limit ? parseInt(request.query.limit, 10) : undefined,
          offset: request.query.offset ? parseInt(request.query.offset, 10) : undefined,
          overrideBasePath: request.query._basePath,
        });
        return result;
      }

      const result = listSessions(handle, resolvedDir, {
        sort: (request.query.sort as 'date' | 'size') ?? 'date',
        order: (request.query.order as 'asc' | 'desc') ?? 'desc',
        limit: request.query.limit ? parseInt(request.query.limit, 10) : undefined,
        offset: request.query.offset ? parseInt(request.query.offset, 10) : undefined,
        overrideBasePath: request.query._basePath,
        idsOnly: request.query.ids_only === 'true',
      });
      return result;
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // GET /:projectDir/:sessionId — Read session transcript
  fastify.get<{
    Params: { handle: string; projectDir: string; sessionId: string };
    Querystring: BaseQuery & { limit?: string; offset?: string };
  }>('/:projectDir/:sessionId', async (request, reply) => {
    const { handle, projectDir, sessionId } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    try {
      const resolvedDir = await resolveProjectDir(projectDir);
      const result = await readSession(handle, resolvedDir, sessionId, {
        limit: request.query.limit ? parseInt(request.query.limit, 10) : undefined,
        offset: request.query.offset ? parseInt(request.query.offset, 10) : undefined,
        overrideBasePath: request.query._basePath,
      });

      if (!result) {
        return reply.code(404).send({ error: 'Session not found' });
      }

      return result;
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // GET /:projectDir/:sessionId/loaded-context — Summarize tool-use footprint
  fastify.get<{
    Params: { handle: string; projectDir: string; sessionId: string };
    Querystring: BaseQuery;
  }>('/:projectDir/:sessionId/loaded-context', async (request, reply) => {
    const { handle, projectDir, sessionId } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    try {
      const resolvedDir = await resolveProjectDir(projectDir);
      const result = await summarizeLoadedContext(handle, resolvedDir, sessionId, {
        overrideBasePath: request.query._basePath,
      });
      if (!result) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      return result;
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // DELETE /:projectDir/:sessionId — Delete session + companion directory
  fastify.delete<{
    Params: { handle: string; projectDir: string; sessionId: string };
    Querystring: BaseQuery;
  }>('/:projectDir/:sessionId', async (request, reply) => {
    const { handle, projectDir, sessionId } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    try {
      const resolvedDir = await resolveProjectDir(projectDir);
      const result = deleteSession(handle, resolvedDir, sessionId, request.query._basePath);

      if (!result) {
        return reply.code(404).send({ error: 'Session not found' });
      }

      // Also delete synced DB record
      await query(
        `DELETE FROM sessions WHERE session_id = $1`,
        [sessionId]
      );

      return reply.code(204).send();
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // POST /bulk-delete — Bulk delete sessions
  fastify.post<{
    Params: { handle: string };
    Querystring: BaseQuery;
    Body: { projectDir?: string; before?: string; sessionIds?: string[] };
  }>('/bulk-delete', async (request, reply) => {
    const { handle } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    const { projectDir, before, sessionIds } = request.body || {};

    // Require at least one filter criterion
    if (!projectDir && !before && (!sessionIds || sessionIds.length === 0)) {
      return reply.code(400).send({
        error: 'At least one filter required: projectDir, before, or sessionIds',
      });
    }

    // Validate before date if provided
    if (before && isNaN(new Date(before).getTime())) {
      return reply.code(400).send({ error: 'Invalid date format for "before"' });
    }

    try {
      const resolvedDir = projectDir ? await resolveProjectDir(projectDir) : undefined;
      const result = bulkDeleteSessions(handle, {
        projectDir: resolvedDir,
        before,
        sessionIds,
        overrideBasePath: request.query._basePath,
      });

      // Also delete synced DB records for the deleted session IDs
      if (sessionIds && sessionIds.length > 0) {
        await query(
          `DELETE FROM sessions WHERE session_id = ANY($1::text[])`,
          [sessionIds]
        );
      }

      return result;
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // ── Session Embeddings ────────────────────────────────────────────────

  // POST /sync-embeddings — Trigger session embedding sync
  fastify.post<{
    Params: { handle: string };
    Querystring: { projectDir?: string; sessionId?: string; force?: string };
  }>('/sync-embeddings', async (request, reply) => {
    const { handle } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    const projectDir = request.query.projectDir;
    const sessionId = request.query.sessionId;
    const force = request.query.force === 'true';

    // Fire and forget — sync runs in background
    syncSessionEmbeddings(handle, { projectDir, sessionId, force }).catch((err) => {
      fastify.log.error(err, 'Session embedding sync failed');
    });

    return { status: 'started', projectDir: projectDir || 'all', sessionId: sessionId || null, force };
  });

  // GET /sync-embeddings/status — Get embedding sync status
  fastify.get<{
    Params: { handle: string };
    Querystring: { projectDir?: string };
  }>('/sync-embeddings/status', async (request, reply) => {
    const { handle } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    const result = await getSessionEmbeddingStatus(handle, request.query.projectDir);
    return result;
  });

  // GET /search — Search sessions using keyword or semantic search
  fastify.get<{
    Params: { handle: string };
    Querystring: { q: string; projectDir?: string; sessionId?: string; excludeSessionId?: string; limit?: string; includeThinking?: string; includeToolCalls?: string; mode?: string };
  }>('/search', async (request, reply) => {
    const { handle } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    const { q, projectDir, sessionId, excludeSessionId, mode } = request.query;
    const limit = request.query.limit ? parseInt(request.query.limit, 10) : 10;
    const includeThinking = request.query.includeThinking !== 'false'; // default true
    const includeToolCalls = request.query.includeToolCalls === 'true'; // default false

    if (!q) {
      return reply.code(400).send({ error: 'q (query) is required' });
    }

    // Validate mode
    const searchMode = mode === 'keyword' ? 'keyword' : 'semantic';

    try {
      const results = await searchSessions(q, {
        assistantHandle: handle,
        projectDir,
        sessionId,
        excludeSessionId,
        limit,
        includeThinking,
        includeToolCalls,
        mode: searchMode,
      });
      return { results };
    } catch (err) {
      if (err instanceof Error && err.message.includes('not enabled')) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // GET /lookup/:sessionId — Lookup session by ID from embeddings database
  fastify.get<{
    Params: { handle: string; sessionId: string };
  }>('/lookup/:sessionId', async (request, reply) => {
    const { handle, sessionId } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    try {
      const result = await getSessionById(sessionId, handle);

      if (!result) {
        return reply.code(404).send({ error: 'Session not found in embeddings database' });
      }

      return result;
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });
};

export default assistantSessionRoutes;
