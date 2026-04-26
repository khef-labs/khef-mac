/**
 * Memory snapshot routes.
 * List, view, and delete content snapshots.
 * Snapshot creation is handled via PATCH /api/projects/:projectId/memories/:memoryId?snapshot=true
 */

import { createHash } from 'crypto';
import { FastifyPluginAsync } from 'fastify';
import { getClient, query } from '../db/client';
import { isUuid } from '../utils/uuid';
import { getCurrentSnapshot } from '../services/snapshots';
import { computeLineDiff, applyContext } from '../services/diff';

interface MemorySnapshot {
  id: string;
  memory_id: string;
  snapshot_number: number;
  content: string;
  content_hash: string;
  source: string | null;
  comments_snapshot: string | null;
  created_at: string;
}

interface SnapshotListItem {
  id: string;
  snapshot_number: number;
  content_hash: string;
  source: string | null;
  created_at: string;
  is_current: boolean;
  has_comments: boolean;
  content_size: number;
  comment_count: number;
}

const memorySnapshotRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/memories/:memoryId/snapshots - List all snapshots
  fastify.get('/', async (request, reply) => {
    const { memoryId } = request.params as { memoryId: string };

    if (!isUuid(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    // Check memory exists
    const memoryResult = await query<{ id: string }>(
      'SELECT id FROM memories WHERE id = $1',
      [memoryId]
    );

    if (memoryResult.length === 0) {
      return reply.code(404).send({ error: 'Memory not found' });
    }

    const currentSnapshot = await getCurrentSnapshot(memoryId);

    // Get all snapshots with size and comment count
    const snapshots = await query<MemorySnapshot & { content_size: number; comment_count: number }>(
      `SELECT id, memory_id, snapshot_number, content_hash, source, comments_snapshot, created_at,
              LENGTH(content) AS content_size,
              COALESCE(jsonb_array_length(comments_snapshot), 0) AS comment_count
       FROM memory_snapshots
       WHERE memory_id = $1
       ORDER BY snapshot_number DESC`,
      [memoryId]
    );

    const result: SnapshotListItem[] = snapshots.map((s) => ({
      id: s.id,
      snapshot_number: s.snapshot_number,
      content_hash: s.content_hash,
      source: s.source,
      created_at: s.created_at,
      is_current: s.snapshot_number === currentSnapshot,
      has_comments: s.comments_snapshot !== null && s.comments_snapshot !== '[]',
      content_size: Number(s.content_size) || 0,
      comment_count: Number(s.comment_count) || 0,
    }));

    return {
      memory_id: memoryId,
      current_snapshot: currentSnapshot,
      snapshots: result,
      total: result.length,
    };
  });

  // GET /api/memories/:memoryId/snapshots/diff?from=N&to=M - Compare two snapshots
  fastify.get('/diff', async (request, reply) => {
    const { memoryId } = request.params as { memoryId: string };
    const { from, to, context, limit: limitStr, offset: offsetStr } = request.query as { from?: string; to?: string; context?: string; limit?: string; offset?: string };

    if (!isUuid(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

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

    // Get memory (always needed for existence check and possibly current content)
    const memoryResult = await query<{ id: string; content: string; updated_at: string }>(
      'SELECT id, content, updated_at FROM memories WHERE id = $1',
      [memoryId]
    );

    if (memoryResult.length === 0) {
      return reply.code(404).send({ error: 'Memory not found' });
    }

    const memory = memoryResult[0];
    const currentSnapshot = await getCurrentSnapshot(memoryId);

    // Helper to resolve snapshot content and metadata
    const resolveSnapshot = async (ref: string) => {
      if (ref === 'current') {
        return {
          content: memory.content,
          snapshot_number: currentSnapshot,
          source: 'current' as const,
          created_at: memory.updated_at,
        };
      }

      const num = parseInt(ref, 10);

      // If this number equals current, return live content
      if (num === currentSnapshot) {
        return {
          content: memory.content,
          snapshot_number: currentSnapshot,
          source: 'current' as const,
          created_at: memory.updated_at,
        };
      }

      const snap = await query<MemorySnapshot>(
        'SELECT snapshot_number, content, source, created_at FROM memory_snapshots WHERE memory_id = $1 AND snapshot_number = $2',
        [memoryId, num]
      );

      if (snap.length === 0) {
        return null;
      }

      return {
        content: snap[0].content,
        snapshot_number: snap[0].snapshot_number,
        source: snap[0].source,
        created_at: snap[0].created_at,
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

    // Apply context trimming (default: 3 lines)
    const contextNum = context !== undefined ? parseInt(context, 10) : 3;
    if (isNaN(contextNum) || contextNum < 0) {
      return reply.code(400).send({ error: '"context" must be a non-negative integer' });
    }
    const allChanges = applyContext(diff.changes, contextNum);

    // Paginate changes array (default: 20, limit=0 returns all)
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
      memory_id: memoryId,
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

  // POST /api/memories/:memoryId/snapshots/bulk-delete - Delete multiple snapshots
  fastify.post('/bulk-delete', async (request, reply) => {
    const { memoryId } = request.params as { memoryId: string };
    const { snapshot_numbers } = request.body as { snapshot_numbers?: number[] };

    if (!isUuid(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    if (!Array.isArray(snapshot_numbers) || snapshot_numbers.length === 0) {
      return reply.code(400).send({ error: 'snapshot_numbers must be a non-empty array of positive integers' });
    }

    if (snapshot_numbers.some((n) => !Number.isInteger(n) || n < 1)) {
      return reply.code(400).send({ error: 'All snapshot_numbers must be positive integers' });
    }

    // Check memory exists
    const memoryResult = await query<{ id: string }>(
      'SELECT id FROM memories WHERE id = $1',
      [memoryId]
    );

    if (memoryResult.length === 0) {
      return reply.code(404).send({ error: 'Memory not found' });
    }

    const currentSnapshot = await getCurrentSnapshot(memoryId);

    if (snapshot_numbers.includes(currentSnapshot)) {
      return reply.code(400).send({ error: `Cannot bulk-delete current snapshot #${currentSnapshot}. Use the single delete endpoint or restore first.` });
    }

    // Delete all requested snapshots in one query
    const result = await query<{ snapshot_number: number }>(
      `DELETE FROM memory_snapshots
       WHERE memory_id = $1 AND snapshot_number = ANY($2::int[])
       RETURNING snapshot_number`,
      [memoryId, snapshot_numbers]
    );

    const deleted = result.map((r) => r.snapshot_number);
    const notFound = snapshot_numbers.filter((n) => !deleted.includes(n));

    return {
      deleted,
      not_found: notFound,
      current_snapshot: currentSnapshot,
      message: `Deleted ${deleted.length} snapshot(s)${notFound.length > 0 ? `, ${notFound.length} not found` : ''}`,
    };
  });

  // GET /api/memories/:memoryId/snapshots/:snapshotNumber - Get specific snapshot content
  fastify.get('/:snapshotNumber', async (request, reply) => {
    const { memoryId, snapshotNumber } = request.params as { memoryId: string; snapshotNumber: string };

    if (!isUuid(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    const snapshotNum = parseInt(snapshotNumber, 10);
    if (isNaN(snapshotNum) || snapshotNum < 1) {
      return reply.code(400).send({ error: 'snapshotNumber must be a positive integer' });
    }

    // Get memory
    const memoryResult = await query<{ id: string; content: string }>(
      'SELECT id, content FROM memories WHERE id = $1',
      [memoryId]
    );

    if (memoryResult.length === 0) {
      return reply.code(404).send({ error: 'Memory not found' });
    }

    const memory = memoryResult[0];
    const currentSnapshot = await getCurrentSnapshot(memoryId);

    // If requesting current snapshot, return from memory table with live comments
    if (snapshotNum === currentSnapshot) {
      const commentsResult = await query<{
        id: string;
        content: string;
        anchor_text: string | null;
        anchor_prefix: string | null;
        anchor_suffix: string | null;
        status: string;
        author: string;
        parent_comment_id: string | null;
        created_at: string;
      }>(
        `SELECT id, content, anchor_text, anchor_prefix, anchor_suffix, status, author, parent_comment_id, created_at
         FROM comments WHERE entity_type = 'memory' AND entity_id = $1 ORDER BY created_at`,
        [memoryId]
      );

      return {
        memory_id: memoryId,
        snapshot_number: currentSnapshot,
        content: memory.content,
        is_current: true,
        source: 'current',
        comments: commentsResult,
      };
    }

    // Otherwise fetch from snapshots table
    const snapshotResult = await query<MemorySnapshot>(
      'SELECT * FROM memory_snapshots WHERE memory_id = $1 AND snapshot_number = $2',
      [memoryId, snapshotNum]
    );

    if (snapshotResult.length === 0) {
      return reply.code(404).send({ error: `Snapshot ${snapshotNum} not found` });
    }

    const s = snapshotResult[0];
    return {
      memory_id: memoryId,
      snapshot_number: s.snapshot_number,
      content: s.content,
      content_hash: s.content_hash,
      source: s.source,
      created_at: s.created_at,
      is_current: false,
      comments: s.comments_snapshot || [],
    };
  });

  // DELETE /api/memories/:memoryId/snapshots/:snapshotNumber - Delete a snapshot
  fastify.delete('/:snapshotNumber', async (request, reply) => {
    const { memoryId, snapshotNumber } = request.params as { memoryId: string; snapshotNumber: string };

    if (!isUuid(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    const snapshotNum = parseInt(snapshotNumber, 10);
    if (isNaN(snapshotNum) || snapshotNum < 1) {
      return reply.code(400).send({ error: 'snapshotNumber must be a positive integer' });
    }

    // Check memory exists
    const memoryResult = await query<{ id: string }>(
      'SELECT id FROM memories WHERE id = $1',
      [memoryId]
    );

    if (memoryResult.length === 0) {
      return reply.code(404).send({ error: 'Memory not found' });
    }

    const currentSnapshot = await getCurrentSnapshot(memoryId);

    // Count total snapshots
    const countResult = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM memory_snapshots WHERE memory_id = $1',
      [memoryId]
    );
    const totalSnapshots = parseInt(countResult[0].count, 10);

    // Check if this is the only snapshot (current with no history)
    if (snapshotNum === currentSnapshot && totalSnapshots === 0) {
      return reply.code(400).send({
        error: 'Cannot delete the only snapshot',
      });
    }

    const client = await getClient();

    try {
      await client.query('BEGIN');

      if (snapshotNum === currentSnapshot) {
        // Deleting current snapshot - restore from previous
        const prevSnapshot = await client.query<MemorySnapshot>(
          `SELECT * FROM memory_snapshots
           WHERE memory_id = $1 AND snapshot_number < $2
           ORDER BY snapshot_number DESC LIMIT 1`,
          [memoryId, snapshotNum]
        );

        if (prevSnapshot.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(400).send({
            error: 'Cannot delete current snapshot - no previous snapshot to restore',
          });
        }

        const prev = prevSnapshot.rows[0];

        // Update memory with previous snapshot's content
        await client.query(
          'UPDATE memories SET content = $1, updated_at = NOW() WHERE id = $2',
          [prev.content, memoryId]
        );

        // Delete the snapshot we're removing (if it exists in snapshots table)
        await client.query(
          'DELETE FROM memory_snapshots WHERE memory_id = $1 AND snapshot_number = $2',
          [memoryId, snapshotNum]
        );

        // Update chunks for restored content
        await client.query('DELETE FROM memory_chunks WHERE memory_id = $1', [memoryId]);
        const CHUNK_SIZE = 2000;
        if (prev.content.length > CHUNK_SIZE) {
          let start = 0;
          let chunkIndex = 0;
          while (start < prev.content.length) {
            const chunk = prev.content.slice(start, start + CHUNK_SIZE);
            await client.query(
              'INSERT INTO memory_chunks (memory_id, chunk_index, content) VALUES ($1, $2, $3)',
              [memoryId, chunkIndex, chunk]
            );
            start += CHUNK_SIZE;
            chunkIndex++;
          }
        }

        await client.query('COMMIT');

        return {
          deleted_snapshot: snapshotNum,
          new_current_snapshot: prev.snapshot_number,
          message: `Deleted snapshot ${snapshotNum}, restored to snapshot ${prev.snapshot_number}`,
        };
      } else {
        // Deleting a non-current snapshot - just remove from history
        const deleteResult = await client.query(
          'DELETE FROM memory_snapshots WHERE memory_id = $1 AND snapshot_number = $2',
          [memoryId, snapshotNum]
        );

        if (deleteResult.rowCount === 0) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: `Snapshot ${snapshotNum} not found` });
        }

        await client.query('COMMIT');

        return {
          deleted_snapshot: snapshotNum,
          current_snapshot: currentSnapshot,
          message: `Deleted snapshot ${snapshotNum}`,
        };
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // POST /api/memories/:memoryId/snapshots/:snapshotNumber/restore - Restore a historical snapshot as current
  fastify.post('/:snapshotNumber/restore', async (request, reply) => {
    const { memoryId, snapshotNumber } = request.params as { memoryId: string; snapshotNumber: string };
    const { skip_snapshot } = (request.body as { skip_snapshot?: boolean }) || {};

    if (!isUuid(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    const snapshotNum = parseInt(snapshotNumber, 10);
    if (isNaN(snapshotNum) || snapshotNum < 1) {
      return reply.code(400).send({ error: 'snapshotNumber must be a positive integer' });
    }

    // Get memory
    const memoryResult = await query<{ id: string; content: string }>(
      'SELECT id, content FROM memories WHERE id = $1',
      [memoryId]
    );

    if (memoryResult.length === 0) {
      return reply.code(404).send({ error: 'Memory not found' });
    }

    const memory = memoryResult[0];

    // Fetch the snapshot to restore
    const snapshotResult = await query<MemorySnapshot>(
      'SELECT * FROM memory_snapshots WHERE memory_id = $1 AND snapshot_number = $2',
      [memoryId, snapshotNum]
    );

    if (snapshotResult.length === 0) {
      return reply.code(404).send({ error: `Snapshot ${snapshotNum} not found` });
    }

    const restoreFrom = snapshotResult[0];

    const client = await getClient();
    let currentSnapshot: number;

    try {
      await client.query('BEGIN');

      // Compute inside the txn so the parent row lock serializes restore vs other writers
      currentSnapshot = await getCurrentSnapshot(memoryId, client);

      if (snapshotNum === currentSnapshot) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ error: 'Snapshot is already current' });
      }

      // Safety snapshot: save current state before restoring (unless skipped)
      if (!skip_snapshot) {
        const contentHash = createHash('sha256').update(memory.content).digest('hex').slice(0, 16);

        const commentsData = await client.query(
          `SELECT id, content, anchor_text, anchor_prefix, anchor_suffix, status, author, parent_comment_id, created_at
           FROM comments WHERE entity_type = 'memory' AND entity_id = $1 ORDER BY created_at`,
          [memoryId]
        );

        await client.query(
          `INSERT INTO memory_snapshots (memory_id, snapshot_number, content, content_hash, source, comments_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [memoryId, currentSnapshot, memory.content, contentHash, 'pre-restore', JSON.stringify(commentsData.rows)]
        );
      }

      // Set memory content to the restored snapshot's content
      await client.query(
        'UPDATE memories SET content = $1, updated_at = NOW() WHERE id = $2',
        [restoreFrom.content, memoryId]
      );
      const newCurrentSnapshot = await getCurrentSnapshot(memoryId, client);

      // Regenerate chunks
      await client.query('DELETE FROM memory_chunks WHERE memory_id = $1', [memoryId]);
      const CHUNK_SIZE = 2000;
      if (restoreFrom.content.length > CHUNK_SIZE) {
        let start = 0;
        let chunkIndex = 0;
        while (start < restoreFrom.content.length) {
          const chunk = restoreFrom.content.slice(start, start + CHUNK_SIZE);
          await client.query(
            'INSERT INTO memory_chunks (memory_id, chunk_index, content) VALUES ($1, $2, $3)',
            [memoryId, chunkIndex, chunk]
          );
          start += CHUNK_SIZE;
          chunkIndex++;
        }
      }

      await client.query('COMMIT');

      return {
        restored_from_snapshot: snapshotNum,
        safety_snapshot: skip_snapshot ? null : currentSnapshot,
        new_current_snapshot: newCurrentSnapshot,
        message: skip_snapshot
          ? `Restored content from snapshot ${snapshotNum}.`
          : `Restored content from snapshot ${snapshotNum}. Previous state saved as snapshot ${currentSnapshot}.`,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
};

export default memorySnapshotRoutes;
