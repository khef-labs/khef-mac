import { FastifyPluginAsync } from 'fastify';
import { query } from '../db/client';
import {
  listMemoryProjects,
  listMemoryFiles,
  getMemoryFile,
  getMemoryFileSnapshots,
  getMemoryFileSnapshot,
  createMemoryFileSnapshot,
  restoreMemoryFileSnapshot,
  writeMemoryFile,
  deleteMemoryFile,
  deleteMemoryFileSnapshot,
  validateFilename,
} from '../services/assistant-memories';
import {
  getSessionsBasePath,
  resolveProjectDir,
  ValidationError,
} from '../services/sessions';

interface BaseQuery {
  _basePath?: string;
}

const assistantMemoryRoutes: FastifyPluginAsync = async (fastify) => {
  // Shared validation: verify assistant exists and supports memory files
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
    if (!getSessionsBasePath(handle)) {
      return {
        valid: false,
        error: `Assistant '${handle}' does not support memory files`,
        status: 400,
      };
    }
    return { valid: true };
  }

  // GET / — List projects with memory directories
  fastify.get<{
    Params: { handle: string };
    Querystring: BaseQuery;
  }>('/', async (request, reply) => {
    const { handle } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    const result = await listMemoryProjects(handle, request.query._basePath);
    return result;
  });

  // GET /:projectDir — List memory files in a project
  fastify.get<{
    Params: { handle: string; projectDir: string };
    Querystring: BaseQuery;
  }>('/:projectDir', async (request, reply) => {
    const { handle, projectDir } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    try {
      const resolvedDir = await resolveProjectDir(projectDir);
      const result = await listMemoryFiles(handle, resolvedDir, request.query._basePath);
      return result;
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // GET /:projectDir/:filename — Get current version of a memory file
  fastify.get<{
    Params: { handle: string; projectDir: string; filename: string };
    Querystring: BaseQuery;
  }>('/:projectDir/:filename', async (request, reply) => {
    const { handle, projectDir, filename } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    try {
      const resolvedDir = await resolveProjectDir(projectDir);
      const file = await getMemoryFile(handle, resolvedDir, filename, request.query._basePath);
      if (!file) {
        return reply.code(404).send({ error: 'Memory file not found' });
      }
      return { file };
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // PUT /:projectDir/:filename — Write file to disk (triggers versioning)
  fastify.put<{
    Params: { handle: string; projectDir: string; filename: string };
    Body: { content: string };
    Querystring: BaseQuery;
  }>('/:projectDir/:filename', async (request, reply) => {
    const { handle, projectDir, filename } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    const { content } = request.body ?? {};
    if (content === undefined || content === null) {
      return reply.code(400).send({ error: 'content is required' });
    }

    try {
      const resolvedDir = await resolveProjectDir(projectDir);
      const file = await writeMemoryFile(handle, resolvedDir, filename, content, request.query._basePath);
      if (!file) {
        return reply.code(500).send({ error: 'Failed to write memory file' });
      }
      return { file };
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // DELETE /:projectDir/:filename — Delete file from disk, preserve DB history
  fastify.delete<{
    Params: { handle: string; projectDir: string; filename: string };
    Querystring: BaseQuery;
  }>('/:projectDir/:filename', async (request, reply) => {
    const { handle, projectDir, filename } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    try {
      const resolvedDir = await resolveProjectDir(projectDir);
      const result = await deleteMemoryFile(handle, resolvedDir, filename, request.query._basePath);
      if (!result.success) {
        const status = result.error === 'Memory file not found' ? 404 : 400;
        return reply.code(status).send({ error: result.error });
      }
      return { success: true };
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // GET /:projectDir/:filename/snapshots — List all snapshots
  fastify.get<{
    Params: { handle: string; projectDir: string; filename: string };
    Querystring: BaseQuery;
  }>('/:projectDir/:filename/snapshots', async (request, reply) => {
    const { handle, projectDir, filename } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    try {
      const resolvedDir = await resolveProjectDir(projectDir);
      // Run discovery first to ensure we have latest
      const { discoverMemoryFiles } = await import('../services/assistant-memories.js');
      await discoverMemoryFiles(handle, resolvedDir, request.query._basePath);

      const result = await getMemoryFileSnapshots(handle, resolvedDir, filename);
      if (!result) {
        return reply.code(404).send({ error: 'Memory file not found' });
      }
      return result;
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // POST /:projectDir/:filename/snapshots — Create a manual snapshot
  fastify.post<{
    Params: { handle: string; projectDir: string; filename: string };
    Querystring: BaseQuery;
  }>('/:projectDir/:filename/snapshots', async (request, reply) => {
    const { handle, projectDir, filename } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    try {
      const resolvedDir = await resolveProjectDir(projectDir);
      const result = await createMemoryFileSnapshot(handle, resolvedDir, filename, request.query._basePath);
      if (!result) {
        return reply.code(404).send({ error: 'Memory file not found' });
      }
      return result;
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // GET /:projectDir/:filename/snapshots/:snapshot — Get specific snapshot
  fastify.get<{
    Params: { handle: string; projectDir: string; filename: string; snapshot: string };
    Querystring: BaseQuery;
  }>('/:projectDir/:filename/snapshots/:snapshot', async (request, reply) => {
    const { handle, projectDir, filename, snapshot: snapshotStr } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    const snapshotNumber = parseInt(snapshotStr, 10);
    if (isNaN(snapshotNumber) || snapshotNumber < 1) {
      return reply.code(400).send({ error: 'Invalid snapshot number' });
    }

    try {
      const resolvedDir = await resolveProjectDir(projectDir);
      const result = await getMemoryFileSnapshot(handle, resolvedDir, filename, snapshotNumber);
      if (!result) {
        return reply.code(404).send({ error: 'Snapshot not found' });
      }
      return { snapshot: result };
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // DELETE /:projectDir/:filename/snapshots/:snapshot — Delete a snapshot (not the last one)
  fastify.delete<{
    Params: { handle: string; projectDir: string; filename: string; snapshot: string };
    Querystring: BaseQuery;
  }>('/:projectDir/:filename/snapshots/:snapshot', async (request, reply) => {
    const { handle, projectDir, filename, snapshot: snapshotStr } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    const snapshotNumber = parseInt(snapshotStr, 10);
    if (isNaN(snapshotNumber) || snapshotNumber < 1) {
      return reply.code(400).send({ error: 'Invalid snapshot number' });
    }

    try {
      const resolvedDir = await resolveProjectDir(projectDir);
      const result = await deleteMemoryFileSnapshot(handle, resolvedDir, filename, snapshotNumber);
      if (!result.deleted) {
        const status = result.error === 'Snapshot not found' ? 404 : 400;
        return reply.code(status).send({ error: result.error });
      }
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // POST /:projectDir/:filename/snapshots/:snapshot/restore — Restore a snapshot
  fastify.post<{
    Params: { handle: string; projectDir: string; filename: string; snapshot: string };
    Querystring: BaseQuery;
  }>('/:projectDir/:filename/snapshots/:snapshot/restore', async (request, reply) => {
    const { handle, projectDir, filename, snapshot: snapshotStr } = request.params;
    const check = await validateAssistant(handle);
    if (!check.valid) return reply.code(check.status!).send({ error: check.error });

    const snapshotNumber = parseInt(snapshotStr, 10);
    if (isNaN(snapshotNumber) || snapshotNumber < 1) {
      return reply.code(400).send({ error: 'Invalid snapshot number' });
    }

    try {
      const resolvedDir = await resolveProjectDir(projectDir);
      const result = await restoreMemoryFileSnapshot(handle, resolvedDir, filename, snapshotNumber, request.query._basePath);
      if (!result) {
        return reply.code(404).send({ error: 'Snapshot not found' });
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

export default assistantMemoryRoutes;
