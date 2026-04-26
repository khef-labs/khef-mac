import { FastifyPluginAsync } from 'fastify';
import { query, getClient } from '../db/client';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { generateExcerpt } from '../utils/excerpt';
import { computeLineDiff, applyContext } from '../services/diff';

interface Prompt {
  id: string;
  handle: string;
  title: string;
  content: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface AssistantPrompt {
  assistant_id: string;
  assistant_handle: string;
  prompt_type: string;
  source_path: string | null;
  file_hash: string | null;
}

interface PromptSnapshot {
  id: string;
  prompt_id: string;
  snapshot_number: number;
  content: string;
  content_hash: string;
  source: string;
  created_at: string;
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function getCurrentSnapshot(promptId: string): Promise<number> {
  const result = await query<{ current: number }>(
    'SELECT COALESCE(MAX(snapshot_number), 0) + 1 AS current FROM prompt_snapshots WHERE prompt_id = $1',
    [promptId]
  );
  return result[0].current;
}

/**
 * Compute the next snapshot_number while holding a row lock on the parent
 * prompt so concurrent writes don't race to assign the same number.
 * Must be called inside an active transaction on the provided client.
 */
async function getNextSnapshotLocked(
  client: import('pg').PoolClient,
  promptId: string
): Promise<number> {
  await client.query('SELECT 1 FROM prompts WHERE id = $1 FOR UPDATE', [promptId]);
  const result = await client.query<{ current: number }>(
    'SELECT COALESCE(MAX(snapshot_number), 0) + 1 AS current FROM prompt_snapshots WHERE prompt_id = $1',
    [promptId]
  );
  return result.rows[0].current;
}

/** Strip a prompt response to minimal fields for compact mutation responses. */
const compactMutationResponse = (prompt: Record<string, any>) => ({
  id: prompt.id,
  handle: prompt.handle,
  title: prompt.title,
  created_at: prompt.created_at,
  updated_at: prompt.updated_at,
});

const promptsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/prompts - List all prompts
  fastify.get('/', async (request) => {
    const { assistant, type, compact, q, limit = '50', offset = '0' } = request.query as {
      assistant?: string;
      type?: string;
      compact?: string;
      q?: string;
      limit?: string;
      offset?: string;
    };

    const limitNum = Math.min(parseInt(limit, 10) || 50, 100);
    const offsetNum = parseInt(offset, 10) || 0;

    let sql: string;
    const params: any[] = [];
    const conditions: string[] = [];

    if (assistant) {
      // Filter by assistant — join through assistant_prompts
      sql = `
        SELECT DISTINCT p.*,
               COUNT(*) OVER() as total_count
        FROM prompts p
        INNER JOIN assistant_prompts ap ON p.id = ap.prompt_id
        INNER JOIN assistants a ON ap.assistant_id = a.id
        WHERE a.handle = $1
      `;
      params.push(assistant);

      if (type) {
        sql += ` AND ap.prompt_type = $${params.length + 1}`;
        params.push(type);
      }

      if (q) {
        sql += ` AND (p.title ILIKE $${params.length + 1} OR p.handle ILIKE $${params.length + 1} OR p.description ILIKE $${params.length + 1})`;
        params.push(`%${q}%`);
      }

      sql += ` ORDER BY p.title ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limitNum, offsetNum);
    } else {
      // All prompts
      if (q) {
        conditions.push(`(p.title ILIKE $${params.length + 1} OR p.handle ILIKE $${params.length + 1} OR p.description ILIKE $${params.length + 1})`);
        params.push(`%${q}%`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      sql = `
        SELECT p.*, COUNT(*) OVER() as total_count
        FROM prompts p
        ${whereClause}
        ORDER BY p.title ASC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;
      params.push(limitNum, offsetNum);
    }

    const results = await query<Prompt & { total_count: string }>(sql, params);
    const totalCount = results.length > 0 ? parseInt(results[0].total_count, 10) : 0;

    // Fetch assistant associations for each prompt
    const promptIds = results.map(r => r.id);
    let assistantMap = new Map<string, AssistantPrompt[]>();

    if (promptIds.length > 0) {
      const associations = await query<{
        prompt_id: string;
        assistant_id: string;
        assistant_handle: string;
        prompt_type: string;
        source_path: string | null;
        file_hash: string | null;
      }>(
        `SELECT ap.prompt_id, ap.assistant_id, a.handle as assistant_handle,
                ap.prompt_type, ap.source_path, ap.file_hash
         FROM assistant_prompts ap
         INNER JOIN assistants a ON ap.assistant_id = a.id
         WHERE ap.prompt_id = ANY($1)`,
        [promptIds]
      );

      for (const assoc of associations) {
        if (!assistantMap.has(assoc.prompt_id)) {
          assistantMap.set(assoc.prompt_id, []);
        }
        assistantMap.get(assoc.prompt_id)!.push({
          assistant_id: assoc.assistant_id,
          assistant_handle: assoc.assistant_handle,
          prompt_type: assoc.prompt_type,
          source_path: assoc.source_path,
          file_hash: assoc.file_hash,
        });
      }
    }

    const isCompact = compact === 'true';

    const prompts = results.map(({ total_count, ...prompt }) => {
      const base = {
        id: prompt.id,
        handle: prompt.handle,
        title: prompt.title,
        description: prompt.description,
        assistants: assistantMap.get(prompt.id) || [],
        created_at: prompt.created_at,
        updated_at: prompt.updated_at,
      };

      if (isCompact) {
        return { ...base, content_excerpt: generateExcerpt(prompt.content) };
      }

      return { ...base, content: prompt.content };
    });

    return {
      prompts,
      pagination: {
        total_count: totalCount,
        limit: limitNum,
        offset: offsetNum,
        has_more: offsetNum + limitNum < totalCount,
      },
    };
  });

  // GET /api/prompts/:id - Get a single prompt
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const results = await query<Prompt>(
      'SELECT * FROM prompts WHERE id = $1',
      [id]
    );

    if (results.length === 0) {
      return reply.code(404).send({ error: 'Prompt not found' });
    }

    const prompt = results[0];

    // Fetch assistant associations
    const associations = await query<{
      assistant_id: string;
      assistant_handle: string;
      prompt_type: string;
      source_path: string | null;
      file_hash: string | null;
    }>(
      `SELECT ap.assistant_id, a.handle as assistant_handle,
              ap.prompt_type, ap.source_path, ap.file_hash
       FROM assistant_prompts ap
       INNER JOIN assistants a ON ap.assistant_id = a.id
       WHERE ap.prompt_id = $1`,
      [id]
    );

    const currentSnapshot = await getCurrentSnapshot(id);

    return {
      prompt: {
        ...prompt,
        current_snapshot: currentSnapshot,
        assistants: associations.map(a => ({
          assistant_id: a.assistant_id,
          assistant_handle: a.assistant_handle,
          prompt_type: a.prompt_type,
          source_path: a.source_path,
          file_hash: a.file_hash,
        })),
      },
    };
  });

  // POST /api/prompts - Create a new prompt
  fastify.post('/', async (request, reply) => {
    const { handle, title, content, description, assistants } = request.body as {
      handle: string;
      title: string;
      content: string;
      description?: string;
      assistants?: Array<{
        assistant_handle: string;
        prompt_type: string;
        source_path?: string;
      }>;
    };

    if (!handle || !title || !content) {
      return reply.code(400).send({ error: 'handle, title, and content are required' });
    }

    // Check handle uniqueness
    const existing = await query('SELECT id FROM prompts WHERE handle = $1', [handle]);
    if (existing.length > 0) {
      return reply.code(409).send({ error: `Prompt with handle '${handle}' already exists` });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Create prompt
      const result = await client.query<{ id: string }>(
        `INSERT INTO prompts (handle, title, content, description)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [handle, title, content, description || null]
      );
      const promptId = result.rows[0].id;

      // Add assistant associations if provided
      if (assistants && assistants.length > 0) {
        for (const assoc of assistants) {
          const assistant = await client.query<{ id: string }>(
            'SELECT id FROM assistants WHERE handle = $1',
            [assoc.assistant_handle]
          );
          if (assistant.rows.length === 0) {
            throw new Error(`Assistant '${assoc.assistant_handle}' not found`);
          }

          const fileHash = assoc.source_path ? null : null; // Will be set on sync
          await client.query(
            `INSERT INTO assistant_prompts (prompt_id, assistant_id, prompt_type, source_path, file_hash)
             VALUES ($1, $2, $3, $4, $5)`,
            [promptId, assistant.rows[0].id, assoc.prompt_type, assoc.source_path || null, fileHash]
          );
        }
      }

      await client.query('COMMIT');

      // Fetch the created prompt
      const created = await query<Prompt>('SELECT * FROM prompts WHERE id = $1', [promptId]);

      const compact = (request.query as Record<string, string>).compact !== 'false';
      return reply.code(201).send({ prompt: compact ? compactMutationResponse(created[0]) : created[0] });
    } catch (error: any) {
      await client.query('ROLLBACK');
      if (error.message.includes('not found')) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    } finally {
      client.release();
    }
  });

  // PATCH /api/prompts/:id - Update a prompt
  fastify.patch('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { title, content, description, snapshot } = request.body as {
      title?: string;
      content?: string;
      description?: string;
      snapshot?: boolean;
    };

    const existing = await query<Prompt>('SELECT * FROM prompts WHERE id = $1', [id]);
    if (existing.length === 0) {
      return reply.code(404).send({ error: 'Prompt not found' });
    }

    const prompt = existing[0];
    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Create snapshot if content is changing and snapshot requested
      if (content && content !== prompt.content && snapshot !== false) {
        const snapshotNum = await getNextSnapshotLocked(client, id);
        const contentHash = computeContentHash(prompt.content);
        await client.query(
          `INSERT INTO prompt_snapshots (prompt_id, snapshot_number, content, content_hash, source)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, snapshotNum, prompt.content, contentHash, 'manual']
        );
      }

      // Build update query
      const updates: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (title !== undefined) {
        updates.push(`title = $${paramIndex++}`);
        params.push(title);
      }
      if (content !== undefined) {
        updates.push(`content = $${paramIndex++}`);
        params.push(content);
      }
      if (description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        params.push(description);
      }

      if (updates.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ error: 'No fields to update' });
      }

      params.push(id);
      await client.query(
        `UPDATE prompts SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramIndex}`,
        params
      );

      await client.query('COMMIT');

      const updated = await query<Prompt>('SELECT * FROM prompts WHERE id = $1', [id]);

      // Sync to disk if content was updated and prompt has source_path associations
      if (content !== undefined) {
        const syncResult = await syncPromptToDisk(id, updated[0].content);
        if (syncResult.conflicts.length > 0) {
          return reply.code(409).send({
            error: 'External file changes detected',
            prompt: updated[0],
            conflicts: syncResult.conflicts,
          });
        }
      }

      const compact = (request.query as Record<string, string>).compact !== 'false';
      return { prompt: compact ? compactMutationResponse(updated[0]) : updated[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  // POST /api/prompts/:id/sync - Sync prompt to disk
  fastify.post('/:id/sync', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { force } = request.query as { force?: string };

    const prompt = await query<Prompt>('SELECT * FROM prompts WHERE id = $1', [id]);
    if (prompt.length === 0) {
      return reply.code(404).send({ error: 'Prompt not found' });
    }

    const syncResult = await syncPromptToDisk(id, prompt[0].content, force === 'true');

    if (syncResult.conflicts.length > 0 && !force) {
      return reply.code(409).send({
        error: 'External file changes detected',
        conflicts: syncResult.conflicts,
      });
    }

    return {
      synced: syncResult.synced,
      conflicts: syncResult.conflicts,
    };
  });

  // GET /api/prompts/:id/sync - Check sync status
  fastify.get('/:id/sync', async (request, reply) => {
    const { id } = request.params as { id: string };

    const prompt = await query<Prompt>('SELECT * FROM prompts WHERE id = $1', [id]);
    if (prompt.length === 0) {
      return reply.code(404).send({ error: 'Prompt not found' });
    }

    // Get associations with source paths
    const associations = await query<{
      assistant_handle: string;
      source_path: string | null;
      file_hash: string | null;
    }>(
      `SELECT a.handle as assistant_handle, ap.source_path, ap.file_hash
       FROM assistant_prompts ap
       INNER JOIN assistants a ON ap.assistant_id = a.id
       WHERE ap.prompt_id = $1 AND ap.source_path IS NOT NULL`,
      [id]
    );

    const status: Array<{
      assistant: string;
      path: string;
      status: 'synced' | 'modified_externally' | 'missing';
      db_hash: string | null;
      file_hash: string | null;
    }> = [];

    for (const assoc of associations) {
      if (!assoc.source_path) continue;

      const expandedPath = assoc.source_path.replace(/^~/, os.homedir());
      let fileStatus: 'synced' | 'modified_externally' | 'missing';
      let currentFileHash: string | null = null;

      if (!fs.existsSync(expandedPath)) {
        fileStatus = 'missing';
      } else {
        const fileContent = fs.readFileSync(expandedPath, 'utf-8');
        currentFileHash = computeContentHash(fileContent);
        fileStatus = currentFileHash === assoc.file_hash ? 'synced' : 'modified_externally';
      }

      status.push({
        assistant: assoc.assistant_handle,
        path: assoc.source_path,
        status: fileStatus,
        db_hash: assoc.file_hash,
        file_hash: currentFileHash,
      });
    }

    return { status };
  });

  // DELETE /api/prompts/:id - Delete a prompt
  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const result = await query('DELETE FROM prompts WHERE id = $1 RETURNING id', [id]);
    if (result.length === 0) {
      return reply.code(404).send({ error: 'Prompt not found' });
    }

    return { success: true };
  });

  // GET /api/prompts/:id/snapshots - List snapshots
  fastify.get('/:id/snapshots', async (request, reply) => {
    const { id } = request.params as { id: string };

    const prompt = await query('SELECT id FROM prompts WHERE id = $1', [id]);
    if (prompt.length === 0) {
      return reply.code(404).send({ error: 'Prompt not found' });
    }

    const snapshots = await query<PromptSnapshot>(
      `SELECT id, prompt_id, snapshot_number, content_hash, source, created_at
       FROM prompt_snapshots
       WHERE prompt_id = $1
       ORDER BY snapshot_number DESC`,
      [id]
    );

    return { snapshots };
  });

  // GET /api/prompts/:id/snapshots/diff?from=N&to=M - Compare two snapshots
  fastify.get('/:id/snapshots/diff', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { from, to, context, limit: limitStr, offset: offsetStr } = request.query as {
      from?: string;
      to?: string;
      context?: string;
      limit?: string;
      offset?: string;
    };

    if (!from || !to) {
      return reply.code(400).send({ error: 'Both "from" and "to" query parameters are required' });
    }

    const fromNum = from === 'current' ? null : parseInt(from, 10);
    const toNum = to === 'current' ? null : parseInt(to, 10);

    if (from !== 'current' && (isNaN(fromNum!) || fromNum! < 1)) {
      return reply.code(400).send({ error: '"from" must be a positive integer or "current"' });
    }
    if (to !== 'current' && (isNaN(toNum!) || toNum! < 1)) {
      return reply.code(400).send({ error: '"to" must be a positive integer or "current"' });
    }

    const prompts = await query<Prompt>('SELECT * FROM prompts WHERE id = $1', [id]);
    if (prompts.length === 0) {
      return reply.code(404).send({ error: 'Prompt not found' });
    }

    const prompt = prompts[0];
    const currentSnapshot = await getCurrentSnapshot(id);

    const resolveSnapshot = async (ref: string) => {
      if (ref === 'current') {
        return {
          content: prompt.content,
          snapshot_number: currentSnapshot,
          source: 'current' as const,
          created_at: prompt.updated_at,
        };
      }

      const num = parseInt(ref, 10);
      if (num === currentSnapshot) {
        return {
          content: prompt.content,
          snapshot_number: currentSnapshot,
          source: 'current' as const,
          created_at: prompt.updated_at,
        };
      }

      const snapshots = await query<PromptSnapshot>(
        'SELECT snapshot_number, content, source, created_at FROM prompt_snapshots WHERE prompt_id = $1 AND snapshot_number = $2',
        [id, num]
      );

      if (snapshots.length === 0) return null;

      return {
        content: snapshots[0].content,
        snapshot_number: snapshots[0].snapshot_number,
        source: snapshots[0].source,
        created_at: snapshots[0].created_at,
      };
    };

    const fromSnap = await resolveSnapshot(from);
    if (!fromSnap) {
      return reply.code(404).send({ error: `Snapshot ${from} not found` });
    }

    const toSnap = await resolveSnapshot(to);
    if (!toSnap) {
      return reply.code(404).send({ error: `Snapshot ${to} not found` });
    }

    const diff = computeLineDiff(fromSnap.content, toSnap.content);

    const contextNum = context !== undefined ? parseInt(context, 10) : 3;
    if (isNaN(contextNum) || contextNum < 0) {
      return reply.code(400).send({ error: '"context" must be a non-negative integer' });
    }
    const allChanges = applyContext(diff.changes, contextNum);

    const DEFAULT_LIMIT = 20;
    const totalChanges = allChanges.length;
    const offset = offsetStr !== undefined ? parseInt(offsetStr, 10) : 0;
    const limit = limitStr !== undefined ? parseInt(limitStr, 10) : DEFAULT_LIMIT;

    if (offsetStr !== undefined && (isNaN(offset) || offset < 0)) {
      return reply.code(400).send({ error: '"offset" must be a non-negative integer' });
    }
    if (limitStr !== undefined && (isNaN(limit) || limit < 0)) {
      return reply.code(400).send({ error: '"limit" must be a non-negative integer (0 for all)' });
    }

    const returnAll = limit === 0;
    const changes = returnAll
      ? allChanges.slice(offset)
      : allChanges.slice(offset, offset + limit);

    return {
      prompt_id: id,
      from: {
        snapshot_number: fromSnap.snapshot_number,
        source: fromSnap.source,
        created_at: fromSnap.created_at,
      },
      to: {
        snapshot_number: toSnap.snapshot_number,
        source: toSnap.source,
        created_at: toSnap.created_at,
      },
      changes,
      stats: diff.stats,
      pagination: {
        total_changes: totalChanges,
        limit: returnAll ? totalChanges : limit,
        offset,
        has_more: returnAll ? false : offset + limit < totalChanges,
      },
    };
  });

  // GET /api/prompts/:id/snapshots/:num - Get specific snapshot
  fastify.get('/:id/snapshots/:num', async (request, reply) => {
    const { id, num } = request.params as { id: string; num: string };
    const snapshotNum = parseInt(num, 10);

    const snapshots = await query<PromptSnapshot>(
      'SELECT * FROM prompt_snapshots WHERE prompt_id = $1 AND snapshot_number = $2',
      [id, snapshotNum]
    );

    if (snapshots.length === 0) {
      return reply.code(404).send({ error: 'Snapshot not found' });
    }

    return { snapshot: snapshots[0] };
  });

  // DELETE /api/prompts/:id/snapshots/:num - Delete specific snapshot
  fastify.delete('/:id/snapshots/:num', async (request, reply) => {
    const { id, num } = request.params as { id: string; num: string };
    const snapshotNum = parseInt(num, 10);

    if (isNaN(snapshotNum) || snapshotNum < 1) {
      return reply.code(400).send({ error: 'snapshotNumber must be a positive integer' });
    }

    const prompts = await query<Prompt>('SELECT * FROM prompts WHERE id = $1', [id]);
    if (prompts.length === 0) {
      return reply.code(404).send({ error: 'Prompt not found' });
    }

    const deleted = await query<PromptSnapshot>(
      'DELETE FROM prompt_snapshots WHERE prompt_id = $1 AND snapshot_number = $2 RETURNING *',
      [id, snapshotNum]
    );

    if (deleted.length === 0) {
      return reply.code(404).send({ error: 'Snapshot not found' });
    }

    return reply.code(204).send();
  });

  // POST /api/prompts/:id/snapshots - Create a manual snapshot
  fastify.post('/:id/snapshots', async (request, reply) => {
    const { id } = request.params as { id: string };

    const prompts = await query<Prompt>('SELECT * FROM prompts WHERE id = $1', [id]);
    if (prompts.length === 0) {
      return reply.code(404).send({ error: 'Prompt not found' });
    }

    const prompt = prompts[0];
    const contentHash = computeContentHash(prompt.content);
    const client = await getClient();

    try {
      await client.query('BEGIN');
      const snapshotNum = await getNextSnapshotLocked(client, id);

      const result = await client.query<PromptSnapshot>(
        `INSERT INTO prompt_snapshots (prompt_id, snapshot_number, content, content_hash, source)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [id, snapshotNum, prompt.content, contentHash, 'manual']
      );

      await client.query('COMMIT');
      return reply.code(201).send({ snapshot: result.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  // POST /api/prompts/:id/assistants - Add assistant association
  fastify.post('/:id/assistants', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { assistant_handle, prompt_type, source_path } = request.body as {
      assistant_handle: string;
      prompt_type: string;
      source_path?: string;
    };

    if (!assistant_handle || !prompt_type) {
      return reply.code(400).send({ error: 'assistant_handle and prompt_type are required' });
    }

    const prompt = await query('SELECT id FROM prompts WHERE id = $1', [id]);
    if (prompt.length === 0) {
      return reply.code(404).send({ error: 'Prompt not found' });
    }

    const assistant = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [assistant_handle]);
    if (assistant.length === 0) {
      return reply.code(400).send({ error: `Assistant '${assistant_handle}' not found` });
    }

    try {
      await query(
        `INSERT INTO assistant_prompts (prompt_id, assistant_id, prompt_type, source_path)
         VALUES ($1, $2, $3, $4)`,
        [id, assistant[0].id, prompt_type, source_path || null]
      );

      return reply.code(201).send({ success: true });
    } catch (error: any) {
      if (error.code === '23505') {
        return reply.code(409).send({ error: 'Prompt already associated with this assistant' });
      }
      throw error;
    }
  });

  // DELETE /api/prompts/:id/assistants/:assistantHandle - Remove assistant association
  fastify.delete('/:id/assistants/:assistantHandle', async (request, reply) => {
    const { id, assistantHandle } = request.params as { id: string; assistantHandle: string };

    const assistant = await query<{ id: string }>('SELECT id FROM assistants WHERE handle = $1', [assistantHandle]);
    if (assistant.length === 0) {
      return reply.code(400).send({ error: `Assistant '${assistantHandle}' not found` });
    }

    const result = await query(
      'DELETE FROM assistant_prompts WHERE prompt_id = $1 AND assistant_id = $2 RETURNING prompt_id',
      [id, assistant[0].id]
    );

    if (result.length === 0) {
      return reply.code(404).send({ error: 'Association not found' });
    }

    return { success: true };
  });

  // POST /api/prompts/discover - Import prompts from disk for all assistants
  fastify.post('/discover', async () => {
    const results: Array<{
      assistant: string;
      type: string;
      action: 'created' | 'updated' | 'unchanged';
      handle: string;
      path: string;
    }> = [];

    // Get all assistants
    const assistants = await query<{ id: string; handle: string }>(
      'SELECT id, handle FROM assistants'
    );

    for (const assistant of assistants) {
      const discovered = await discoverAssistantPrompts(assistant.id, assistant.handle);
      results.push(...discovered);
    }

    return { results, total: results.length };
  });

  // POST /api/prompts/discover/:assistantHandle - Import prompts from disk for specific assistant
  fastify.post('/discover/:assistantHandle', async (request, reply) => {
    const { assistantHandle } = request.params as { assistantHandle: string };

    const assistant = await query<{ id: string; handle: string }>(
      'SELECT id, handle FROM assistants WHERE handle = $1',
      [assistantHandle]
    );

    if (assistant.length === 0) {
      return reply.code(404).send({ error: `Assistant '${assistantHandle}' not found` });
    }

    const results = await discoverAssistantPrompts(assistant[0].id, assistant[0].handle);

    return { results, total: results.length };
  });
};

// Discovery helpers

interface PromptSource {
  type: 'agent' | 'command' | 'prompt';
  dirPath: string;
}

function getAssistantPromptSources(assistantHandle: string): PromptSource[] {
  const sources: PromptSource[] = [];
  const home = os.homedir();

  if (assistantHandle === 'claude-code') {
    const agentsPath = path.join(home, '.claude', 'agents');
    const commandsPath = path.join(home, '.claude', 'commands');

    if (fs.existsSync(agentsPath)) {
      sources.push({ type: 'agent', dirPath: agentsPath });
    }
    if (fs.existsSync(commandsPath)) {
      sources.push({ type: 'command', dirPath: commandsPath });
    }
  } else if (assistantHandle === 'codex-cli') {
    const promptsPath = path.join(home, '.codex', 'prompts');

    if (fs.existsSync(promptsPath)) {
      sources.push({ type: 'prompt', dirPath: promptsPath });
    }
  }

  return sources;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }

  const [, yamlContent, body] = match;
  const frontmatter: Record<string, string> = {};

  for (const line of yamlContent.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key) {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body: body.trim() };
}

async function discoverAssistantPrompts(
  assistantId: string,
  assistantHandle: string
): Promise<Array<{
  assistant: string;
  type: string;
  action: 'created' | 'updated' | 'unchanged';
  handle: string;
  path: string;
}>> {
  const results: Array<{
    assistant: string;
    type: string;
    action: 'created' | 'updated' | 'unchanged';
    handle: string;
    path: string;
  }> = [];

  const sources = getAssistantPromptSources(assistantHandle);

  for (const source of sources) {
    const files = fs.readdirSync(source.dirPath).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const filePath = path.join(source.dirPath, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);

      const name = frontmatter.name || path.basename(file, '.md');
      const handle = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const title = frontmatter.name || name;
      const description = frontmatter.description || null;
      const fileHash = computeContentHash(content);

      const client = await getClient();
      try {
        await client.query('BEGIN');

        // Check if prompt with this handle exists
        const existing = await client.query<{
          id: string;
          content: string;
        }>('SELECT id, content FROM prompts WHERE handle = $1', [handle]);

        let promptId: string;
        let action: 'created' | 'updated' | 'unchanged';

        if (existing.rows.length === 0) {
          // Create new prompt
          const ins = await client.query<{ id: string }>(
            `INSERT INTO prompts (handle, title, content, description)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [handle, title, body, description]
          );
          promptId = ins.rows[0].id;
          action = 'created';
        } else {
          promptId = existing.rows[0].id;
          const existingContent = existing.rows[0].content;

          if (existingContent !== body) {
            // Content changed - create snapshot and update (locks parent row)
            const snapshotNum = await getNextSnapshotLocked(client, promptId);
            const contentHash = computeContentHash(existingContent);
            await client.query(
              `INSERT INTO prompt_snapshots (prompt_id, snapshot_number, content, content_hash, source)
               VALUES ($1, $2, $3, $4, $5)`,
              [promptId, snapshotNum, existingContent, contentHash, 'pre-sync']
            );

            await client.query(
              `UPDATE prompts SET content = $1, title = $2, description = $3, updated_at = NOW()
               WHERE id = $4`,
              [body, title, description, promptId]
            );
            action = 'updated';
          } else {
            action = 'unchanged';
          }
        }

        // Ensure assistant association exists
        const assocExists = await client.query(
          'SELECT 1 FROM assistant_prompts WHERE prompt_id = $1 AND assistant_id = $2',
          [promptId, assistantId]
        );

        if (assocExists.rows.length === 0) {
          await client.query(
            `INSERT INTO assistant_prompts (prompt_id, assistant_id, prompt_type, source_path, file_hash)
             VALUES ($1, $2, $3, $4, $5)`,
            [promptId, assistantId, source.type, filePath, fileHash]
          );
        } else {
          // Update source_path and file_hash
          await client.query(
            `UPDATE assistant_prompts SET source_path = $1, file_hash = $2, updated_at = NOW()
             WHERE prompt_id = $3 AND assistant_id = $4`,
            [filePath, fileHash, promptId, assistantId]
          );
        }

        await client.query('COMMIT');

        results.push({
          assistant: assistantHandle,
          type: source.type,
          action,
          handle,
          path: filePath,
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  }

  return results;
}

// Sync prompt content to disk files
async function syncPromptToDisk(
  promptId: string,
  content: string,
  force: boolean = false
): Promise<{
  synced: Array<{ assistant: string; path: string }>;
  conflicts: Array<{ assistant: string; path: string; db_hash: string | null; file_hash: string }>;
}> {
  const synced: Array<{ assistant: string; path: string }> = [];
  const conflicts: Array<{ assistant: string; path: string; db_hash: string | null; file_hash: string }> = [];

  // Get associations with source paths
  const associations = await query<{
    assistant_id: string;
    assistant_handle: string;
    source_path: string | null;
    file_hash: string | null;
  }>(
    `SELECT ap.assistant_id, a.handle as assistant_handle, ap.source_path, ap.file_hash
     FROM assistant_prompts ap
     INNER JOIN assistants a ON ap.assistant_id = a.id
     WHERE ap.prompt_id = $1 AND ap.source_path IS NOT NULL`,
    [promptId]
  );

  for (const assoc of associations) {
    if (!assoc.source_path) continue;

    const expandedPath = assoc.source_path.replace(/^~/, os.homedir());

    // Check if file exists and get current hash
    if (fs.existsSync(expandedPath)) {
      const currentContent = fs.readFileSync(expandedPath, 'utf-8');
      const currentFileHash = computeContentHash(currentContent);

      // Detect conflict: file changed externally since last sync
      if (assoc.file_hash && currentFileHash !== assoc.file_hash && !force) {
        conflicts.push({
          assistant: assoc.assistant_handle,
          path: assoc.source_path,
          db_hash: assoc.file_hash,
          file_hash: currentFileHash,
        });
        continue;
      }

      // Build file content preserving frontmatter if present
      const { frontmatter } = parseFrontmatter(currentContent);
      const newFileContent = buildFileContent(frontmatter, content);

      // Write to disk
      fs.writeFileSync(expandedPath, newFileContent, 'utf-8');

      // Update file_hash in DB
      const newHash = computeContentHash(newFileContent);
      await query(
        `UPDATE assistant_prompts SET file_hash = $1, updated_at = NOW()
         WHERE prompt_id = $2 AND assistant_id = $3`,
        [newHash, promptId, assoc.assistant_id]
      );

      synced.push({ assistant: assoc.assistant_handle, path: assoc.source_path });
    } else {
      // File doesn't exist - create it
      const newFileContent = buildFileContent({}, content);

      // Ensure directory exists
      const dir = path.dirname(expandedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(expandedPath, newFileContent, 'utf-8');

      const newHash = computeContentHash(newFileContent);
      await query(
        `UPDATE assistant_prompts SET file_hash = $1, updated_at = NOW()
         WHERE prompt_id = $2 AND assistant_id = $3`,
        [newHash, promptId, assoc.assistant_id]
      );

      synced.push({ assistant: assoc.assistant_handle, path: assoc.source_path });
    }
  }

  return { synced, conflicts };
}

function buildFileContent(frontmatter: Record<string, string>, body: string): string {
  // If no frontmatter fields, just return the body
  if (Object.keys(frontmatter).length === 0) {
    return body + '\n';
  }

  // Reconstruct frontmatter
  const fmLines = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  return `---\n${fmLines}\n---\n\n${body}\n`;
}

export default promptsRoutes;
