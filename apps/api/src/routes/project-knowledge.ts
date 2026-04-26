import { FastifyPluginAsync } from 'fastify';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { query, getClient } from '../db/client';
import { resolveProject } from './projects';
import { syncProjectKnowledge, syncUserKnowledge, syncUserGlossary, syncProjectGlossary, KnowledgeData } from '../services/knowledge-sync';

function expandTilde(path: string): string {
  if (path.startsWith('~/')) {
    return homedir() + path.slice(1);
  }
  if (path === '~') {
    return homedir();
  }
  return path;
}

interface KnowledgeMemory {
  id: string;
  handle: string;
  title: string;
  content: string;
  updated_at: string;
}

interface KnowledgeResponse {
  project_id: string;
  project_handle: string;
  commands: KnowledgeMemory[];
  context: KnowledgeMemory[];
  patterns: KnowledgeMemory[];
}

const CHUNK_SIZE = 2000;

const chunkText = (text: string): string[] => {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + CHUNK_SIZE));
    start += CHUNK_SIZE;
  }
  return chunks;
};

async function getMemoryTypeId(typeName: string): Promise<string | null> {
  const result = await query<{ id: string }>(
    'SELECT id FROM memory_types WHERE name = $1',
    [typeName]
  );
  return result.length > 0 ? result[0].id : null;
}

async function getDefaultStatusId(memoryTypeId: string): Promise<string | null> {
  const result = await query<{ id: string }>(
    'SELECT id FROM memory_type_statuses WHERE memory_type_id = $1 ORDER BY sort_order LIMIT 1',
    [memoryTypeId]
  );
  return result.length > 0 ? result[0].id : null;
}

async function upsertMemory(
  projectId: string,
  handle: string,
  title: string,
  typeName: string,
  content: string
): Promise<KnowledgeMemory> {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    // Get memory type ID
    const typeResult = await client.query<{ id: string }>(
      'SELECT id FROM memory_types WHERE name = $1',
      [typeName]
    );
    if (typeResult.rows.length === 0) {
      throw new Error(`Unknown memory type: ${typeName}`);
    }
    const memoryTypeId = typeResult.rows[0].id;

    // Check if memory with this handle exists
    const existingResult = await client.query<{ id: string }>(
      'SELECT id FROM memories WHERE project_id = $1 AND handle = $2',
      [projectId, handle]
    );

    let memoryId: string;

    if (existingResult.rows.length > 0) {
      // Update existing memory (mark for vector sync)
      memoryId = existingResult.rows[0].id;

      await client.query(
        'UPDATE memories SET title = $1, content = $2, updated_at = NOW(), vector_synced_at = NULL WHERE id = $3',
        [title, content, memoryId]
      );

      // Delete old chunks and re-chunk
      await client.query('DELETE FROM memory_chunks WHERE memory_id = $1', [memoryId]);
    } else {
      // Create new memory
      const statusResult = await client.query<{ id: string }>(
        'SELECT id FROM memory_type_statuses WHERE memory_type_id = $1 ORDER BY sort_order LIMIT 1',
        [memoryTypeId]
      );
      const statusId = statusResult.rows[0]?.id;

      const insertResult = await client.query<{ id: string }>(
        `INSERT INTO memories (project_id, handle, title, content, memory_type_id, status_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [projectId, handle, title, content, memoryTypeId, statusId]
      );
      memoryId = insertResult.rows[0].id;
    }

    // Create chunks if content is large
    const chunks = chunkText(content);
    if (chunks.length > 1) {
      for (let i = 0; i < chunks.length; i++) {
        await client.query(
          'INSERT INTO memory_chunks (memory_id, chunk_index, content) VALUES ($1, $2, $3)',
          [memoryId, i, chunks[i]]
        );
      }
    }

    // Fetch the updated memory
    const memoryResult = await client.query<KnowledgeMemory>(
      'SELECT id, handle, title, content, updated_at FROM memories WHERE id = $1',
      [memoryId]
    );

    await client.query('COMMIT');
    return memoryResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const projectKnowledgeRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/projects/:projectId/knowledge - Get all project knowledge
  fastify.get('/', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Get commands memory (handle = 'project-commands', type = 'commands')
    // Exclude deprecated/inactive statuses
    const commandsResult = await query<KnowledgeMemory>(
      `SELECT m.id, m.handle, m.title, m.content, m.updated_at
       FROM memories m
       JOIN memory_types mt ON m.memory_type_id = mt.id
       JOIN memory_type_statuses mts ON m.status_id = mts.id
       WHERE m.project_id = $1 AND mt.name = 'commands'
         AND mts.status_value NOT IN ('deprecated', 'inactive')`,
      [project.id]
    );

    // Get context memories (type = 'context', child of knowledge)
    // Exclude deprecated/inactive statuses
    const contextResult = await query<KnowledgeMemory>(
      `SELECT m.id, m.handle, m.title, m.content, m.updated_at
       FROM memories m
       JOIN memory_types mt ON m.memory_type_id = mt.id
       JOIN memory_type_statuses mts ON m.status_id = mts.id
       WHERE m.project_id = $1 AND mt.name = 'context' AND mt.parent_id IS NOT NULL
         AND mts.status_value NOT IN ('deprecated', 'inactive')
       ORDER BY m.updated_at DESC`,
      [project.id]
    );

    // Get pattern memories (type = 'pattern', child of knowledge)
    // Exclude deprecated/inactive statuses
    const patternsResult = await query<KnowledgeMemory>(
      `SELECT m.id, m.handle, m.title, m.content, m.updated_at
       FROM memories m
       JOIN memory_types mt ON m.memory_type_id = mt.id
       JOIN memory_type_statuses mts ON m.status_id = mts.id
       WHERE m.project_id = $1 AND mt.name = 'pattern' AND mt.parent_id IS NOT NULL
         AND mts.status_value NOT IN ('deprecated', 'inactive')
       ORDER BY m.updated_at DESC`,
      [project.id]
    );

    const response: KnowledgeResponse = {
      project_id: project.id,
      project_handle: project.handle,
      commands: commandsResult,
      context: contextResult,
      patterns: patternsResult,
    };

    return response;
  });

  // PUT /api/projects/:projectId/knowledge/commands - Upsert commands
  fastify.put('/commands', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { content } = request.body as { content: string };

    if (!content || typeof content !== 'string') {
      return reply.code(400).send({ error: 'content is required' });
    }

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const memory = await upsertMemory(
      project.id,
      'project-commands',
      'Project commands',
      'commands',
      content
    );

    return { memory };
  });

  // PUT /api/projects/:projectId/knowledge/context/:handle - Upsert context
  fastify.put('/context/:handle', async (request, reply) => {
    const { projectId, handle: rawHandle } = request.params as { projectId: string; handle: string };
    const { title, content } = request.body as { title: string; content: string };

    if (!title || typeof title !== 'string') {
      return reply.code(400).send({ error: 'title is required' });
    }
    if (!content || typeof content !== 'string') {
      return reply.code(400).send({ error: 'content is required' });
    }

    // Strip prefix if already present, then validate
    const handle = rawHandle.startsWith('ctx-') ? rawHandle.slice(4) : rawHandle;

    // Validate handle format
    if (!/^[a-z0-9-]+$/.test(handle)) {
      return reply.code(400).send({ error: 'handle must be lowercase alphanumeric with hyphens' });
    }

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const memory = await upsertMemory(
      project.id,
      `ctx-${handle}`,
      title,
      'context',
      content
    );

    return { memory };
  });

  // PUT /api/projects/:projectId/knowledge/patterns/:handle - Upsert pattern
  fastify.put('/patterns/:handle', async (request, reply) => {
    const { projectId, handle: rawHandle } = request.params as { projectId: string; handle: string };
    const { title, content } = request.body as { title: string; content: string };

    if (!title || typeof title !== 'string') {
      return reply.code(400).send({ error: 'title is required' });
    }
    if (!content || typeof content !== 'string') {
      return reply.code(400).send({ error: 'content is required' });
    }

    // Strip prefix if already present, then validate
    const handle = rawHandle.startsWith('pattern-') ? rawHandle.slice(8) : rawHandle;

    // Validate handle format
    if (!/^[a-z0-9-]+$/.test(handle)) {
      return reply.code(400).send({ error: 'handle must be lowercase alphanumeric with hyphens' });
    }

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const memory = await upsertMemory(
      project.id,
      `pattern-${handle}`,
      title,
      'pattern',
      content
    );

    return { memory };
  });

  // DELETE /api/projects/:projectId/knowledge/context/:handle - Delete context
  fastify.delete('/context/:handle', async (request, reply) => {
    const { projectId, handle: rawHandle } = request.params as { projectId: string; handle: string };

    // Strip prefix if already present
    const handle = rawHandle.startsWith('ctx-') ? rawHandle.slice(4) : rawHandle;

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Get memory ID first to queue for vector delete
    const existing = await query<{ id: string }>(
      'SELECT id FROM memories WHERE project_id = $1 AND handle = $2',
      [project.id, `ctx-${handle}`]
    );

    if (existing.length === 0) {
      return reply.code(404).send({ error: 'Context not found' });
    }

    // Queue for vector delete
    await query(
      'INSERT INTO vector_delete_queue (memory_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [existing[0].id]
    );

    // Delete comments (no FK cascade since comments are polymorphic)
    await query(
      "DELETE FROM comments WHERE entity_type = 'memory' AND entity_id = $1",
      [existing[0].id]
    );

    await query(
      'DELETE FROM memories WHERE id = $1',
      [existing[0].id]
    );

    return reply.code(204).send();
  });

  // DELETE /api/projects/:projectId/knowledge/patterns/:handle - Delete pattern
  fastify.delete('/patterns/:handle', async (request, reply) => {
    const { projectId, handle: rawHandle } = request.params as { projectId: string; handle: string };

    // Strip prefix if already present
    const handle = rawHandle.startsWith('pattern-') ? rawHandle.slice(8) : rawHandle;

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Get memory ID first to queue for vector delete
    const existing = await query<{ id: string }>(
      'SELECT id FROM memories WHERE project_id = $1 AND handle = $2',
      [project.id, `pattern-${handle}`]
    );

    if (existing.length === 0) {
      return reply.code(404).send({ error: 'Pattern not found' });
    }

    // Queue for vector delete
    await query(
      'INSERT INTO vector_delete_queue (memory_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [existing[0].id]
    );

    // Delete comments (no FK cascade since comments are polymorphic)
    await query(
      "DELETE FROM comments WHERE entity_type = 'memory' AND entity_id = $1",
      [existing[0].id]
    );

    await query(
      'DELETE FROM memories WHERE id = $1',
      [existing[0].id]
    );

    return reply.code(204).send();
  });

  // POST /api/projects/:projectId/knowledge/sync - Sync knowledge to disk
  fastify.post('/sync', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { location } = (request.body || {}) as { location?: string };

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Special case: user project syncs to ~/.claude/
    const isUserProject = project.handle === 'user';
    const targetPath = location || project.path || (isUserProject ? '~/.claude' : null);
    if (!targetPath) {
      return reply.code(400).send({
        error: 'Location required',
        message:
          'No project path configured. Either provide "location" in the request body or set the project path via PATCH /api/projects/:id.',
      });
    }

    const expandedLocation = expandTilde(targetPath);
    if (!existsSync(expandedLocation)) {
      return reply.code(400).send({
        error: 'Invalid location',
        message: `Directory does not exist: ${targetPath}${targetPath !== expandedLocation ? ` (expanded to ${expandedLocation})` : ''}`,
      });
    }

    // Fetch non-deprecated knowledge for sync
    // Excludes deprecated items to match validation behavior
    const commandsResult = await query<KnowledgeMemory>(
      `SELECT m.id, m.handle, m.title, m.content, m.updated_at
       FROM memories m
       JOIN memory_types mt ON m.memory_type_id = mt.id
       JOIN memory_type_statuses mts ON m.status_id = mts.id
       WHERE m.project_id = $1 AND mt.name = 'commands'
         AND mts.status_value NOT IN ('deprecated', 'inactive')`,
      [project.id]
    );

    const contextResult = await query<KnowledgeMemory>(
      `SELECT m.id, m.handle, m.title, m.content, m.updated_at
       FROM memories m
       JOIN memory_types mt ON m.memory_type_id = mt.id
       JOIN memory_type_statuses mts ON m.status_id = mts.id
       WHERE m.project_id = $1 AND mt.name = 'context' AND mt.parent_id IS NOT NULL
         AND mts.status_value NOT IN ('deprecated', 'inactive')
       ORDER BY m.updated_at DESC`,
      [project.id]
    );

    const patternsResult = await query<KnowledgeMemory>(
      `SELECT m.id, m.handle, m.title, m.content, m.updated_at
       FROM memories m
       JOIN memory_types mt ON m.memory_type_id = mt.id
       JOIN memory_type_statuses mts ON m.status_id = mts.id
       WHERE m.project_id = $1 AND mt.name = 'pattern' AND mt.parent_id IS NOT NULL
         AND mts.status_value NOT IN ('deprecated', 'inactive')
       ORDER BY m.updated_at DESC`,
      [project.id]
    );

    const knowledge: KnowledgeData = {
      project_id: project.id,
      project_handle: project.handle,
      commands: commandsResult,
      context: contextResult,
      patterns: patternsResult,
    };

    // User project syncs to ~/.claude/KF-USER-KNOWLEDGE.md with import in CLAUDE.md
    const results = isUserProject
      ? syncUserKnowledge(knowledge)
      : syncProjectKnowledge(knowledge, expandedLocation, project.handle);

    return {
      status: 'success',
      project: project.handle,
      results,
    };
  });

  // POST /api/projects/:projectId/glossary/sync - Sync glossary to disk
  fastify.post('/glossary/sync', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { location } = (request.body || {}) as { location?: string };

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const isUserProject = project.handle === 'user';
    const targetPath = location || project.path || (isUserProject ? '~/.claude' : null);

    if (!isUserProject && !targetPath) {
      return reply.code(400).send({
        error: 'Location required',
        message:
          'No project path configured. Either provide "location" in the request body or set the project path via PATCH /api/projects/:id.',
      });
    }

    let results;
    if (isUserProject) {
      results = syncUserGlossary();
    } else {
      const expandedLocation = expandTilde(targetPath!);
      if (!existsSync(expandedLocation)) {
        return reply.code(400).send({
          error: 'Invalid location',
          message: `Directory does not exist: ${targetPath}${targetPath !== expandedLocation ? ` (expanded to ${expandedLocation})` : ''}`,
        });
      }
      results = syncProjectGlossary(expandedLocation);
    }

    return {
      status: 'success',
      project: project.handle,
      results,
    };
  });
};

export default projectKnowledgeRoutes;
