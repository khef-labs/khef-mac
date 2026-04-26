/**
 * Background sync worker for vector embeddings.
 * Uses kvec (pgvector) for storage — no external vector provider needed.
 *
 * Two-phase sync:
 *   1. Embed + store: chunk content, generate embeddings, upsert into kvec
 *   2. Delete: process vector_delete_queue entries
 */

import { workerLogger } from '../lib/logger';
import pool from '../db/client';
import { getMemoriesCollection } from './kvec-service';
import type { Collection } from '@khef/kvec';

const log = workerLogger.child({ component: 'vector-sync' });

const SYNC_INTERVAL_MS = 30_000; // 30 seconds
const DEFAULT_BATCH_SIZE = 50;

export interface SyncResult {
  embedded: number;
  deleted: number;
  errors: number;
}

interface PendingMemory {
  id: string;
  project_id: string;
  type_name: string;
  content: string;
}

let syncInterval: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * Query memories that need embedding (new or updated since last sync).
 */
async function getMemoriesNeedingSync(batchSize: number): Promise<PendingMemory[]> {
  const result = await pool.query<PendingMemory>(`
    SELECT
      m.id,
      m.project_id,
      mt.name as type_name,
      m.content
    FROM memories m
    JOIN memory_types mt ON mt.id = m.memory_type_id
    LEFT JOIN memory_types mt_parent ON mt_parent.id = mt.parent_id
    WHERE (m.vector_synced_at IS NULL OR m.vector_synced_at < m.updated_at)
      AND mt.name != 'canvas'
      AND COALESCE(mt_parent.name, '') != 'canvas'
    ORDER BY m.updated_at ASC
    LIMIT $1
  `, [batchSize]);

  return result.rows;
}

/**
 * Get memory IDs from the delete queue.
 */
async function getDeleteQueue(batchSize: number): Promise<string[]> {
  const result = await pool.query<{ memory_id: string }>(`
    SELECT memory_id FROM vector_delete_queue
    ORDER BY created_at ASC
    LIMIT $1
  `, [batchSize]);

  return result.rows.map((r) => r.memory_id);
}

/**
 * Phase 1: Embed + store memories into kvec.
 * Each memory is chunked, embedded, and stored in a single step.
 */
async function runEmbedPhase(
  collection: Collection,
  batchSize: number
): Promise<{ embedded: number; errors: number }> {
  const result = { embedded: 0, errors: 0 };

  const pending = await getMemoriesNeedingSync(batchSize);
  if (pending.length === 0) return result;

  log.info({ count: pending.length }, 'Embedding memories');

  for (const memory of pending) {
    try {
      await collection.ingestContent(memory.id, memory.content, {
        language: 'text',
        metadata: {
          memory_id: memory.id,
          project_id: memory.project_id,
          type: memory.type_name,
        },
      });

      await pool.query(
        'UPDATE memories SET vector_synced_at = NOW() WHERE id = $1',
        [memory.id]
      );

      result.embedded++;
    } catch (err) {
      log.error({ err, memoryId: memory.id }, 'Error embedding memory');
      result.errors++;
    }
  }

  return result;
}

/**
 * Phase 2: Process delete queue — remove from kvec.
 */
async function runDeletePhase(
  collection: Collection,
  batchSize: number
): Promise<{ deleted: number; errors: number }> {
  const result = { deleted: 0, errors: 0 };

  const deleteIds = await getDeleteQueue(batchSize);

  for (const memoryId of deleteIds) {
    try {
      await collection.deleteDocument(memoryId);
      await pool.query('DELETE FROM vector_delete_queue WHERE memory_id = $1', [memoryId]);
      result.deleted++;
    } catch (err) {
      log.error({ err, memoryId }, 'Error deleting memory from kvec');
      result.errors++;
    }
  }

  return result;
}

/**
 * Run a complete sync cycle (both phases).
 */
export async function runSyncCycle(): Promise<SyncResult> {
  const result: SyncResult = { embedded: 0, deleted: 0, errors: 0 };

  const collection = await getMemoriesCollection();

  // Phase 1: Embed + store
  const embedResult = await runEmbedPhase(collection, DEFAULT_BATCH_SIZE);
  result.embedded = embedResult.embedded;
  result.errors += embedResult.errors;

  // Phase 2: Process deletes
  const deleteResult = await runDeletePhase(collection, DEFAULT_BATCH_SIZE);
  result.deleted = deleteResult.deleted;
  result.errors += deleteResult.errors;

  if (result.embedded > 0 || result.deleted > 0 || result.errors > 0) {
    log.info(result, 'Cycle complete');
  }

  return result;
}

/**
 * Check if vector sync is enabled via settings.
 */
async function isVectorEnabled(): Promise<boolean> {
  const result = await pool.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'vector.enabled'`
  );
  return result.rows.length > 0 && result.rows[0].value === 'true';
}

/**
 * Start the background sync worker.
 */
export async function startVectorSyncWorker(): Promise<void> {
  if (syncInterval) {
    log.info('Worker already running');
    return;
  }

  const enabled = await isVectorEnabled();
  if (!enabled) {
    log.info('Vector sync disabled, worker not started');
    return;
  }

  log.info({ interval: SYNC_INTERVAL_MS }, 'Worker started');

  // Run immediately on start
  if (!isRunning) {
    isRunning = true;
    try {
      await runSyncCycle();
    } finally {
      isRunning = false;
    }
  }

  // Schedule periodic sync
  syncInterval = setInterval(async () => {
    if (isRunning) {
      log.debug('Previous cycle still running, skipping');
      return;
    }

    isRunning = true;
    try {
      const enabled = await isVectorEnabled();
      if (!enabled) {
        log.info('Vector sync disabled, stopping worker');
        stopVectorSyncWorker();
        return;
      }

      await runSyncCycle();
    } catch (err) {
      log.error({ err }, 'Error in sync cycle');
    } finally {
      isRunning = false;
    }
  }, SYNC_INTERVAL_MS);
}

/**
 * Stop the background sync worker.
 */
export function stopVectorSyncWorker(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    log.info('Worker stopped');
  }
}

/**
 * Check if the worker is currently running.
 */
export function isWorkerRunning(): boolean {
  return syncInterval !== null;
}

/**
 * Get sync status (pending counts).
 */
export async function getSyncStatus(): Promise<{
  pending_sync: number;
  delete_queue_count: number;
  worker_running: boolean;
}> {
  const [syncResult, deleteResult] = await Promise.all([
    pool.query<{ count: string }>(`
      SELECT COUNT(*) as count FROM memories m
      JOIN memory_types mt ON mt.id = m.memory_type_id
      LEFT JOIN memory_types mt_parent ON mt_parent.id = mt.parent_id
      WHERE (m.vector_synced_at IS NULL OR m.vector_synced_at < m.updated_at)
        AND mt.name != 'canvas'
        AND COALESCE(mt_parent.name, '') != 'canvas'
    `),
    pool.query<{ count: string }>(`
      SELECT COUNT(*) as count FROM vector_delete_queue
    `),
  ]);

  return {
    pending_sync: parseInt(syncResult.rows[0].count, 10),
    delete_queue_count: parseInt(deleteResult.rows[0].count, 10),
    worker_running: isWorkerRunning(),
  };
}

/**
 * Trigger an immediate sync (for manual sync endpoint).
 */
export async function triggerImmediateSync(options?: {
  projectId?: string;
  force?: boolean;
}): Promise<SyncResult> {
  const enabled = await isVectorEnabled();
  if (!enabled) {
    throw new Error('Vector sync is not enabled');
  }

  // If force, reset vector_synced_at to trigger re-embedding
  if (options?.force) {
    if (options.projectId) {
      await pool.query(
        `UPDATE memories SET vector_synced_at = NULL WHERE project_id = $1`,
        [options.projectId]
      );
    } else {
      await pool.query(`UPDATE memories SET vector_synced_at = NULL`);
    }
  }

  // Run sync cycles until no more pending
  const totalResult: SyncResult = { embedded: 0, deleted: 0, errors: 0 };

  let cycleResult: SyncResult;
  do {
    cycleResult = await runSyncCycle();
    totalResult.embedded += cycleResult.embedded;
    totalResult.deleted += cycleResult.deleted;
    totalResult.errors += cycleResult.errors;
  } while (cycleResult.embedded > 0 || cycleResult.deleted > 0);

  return totalResult;
}
