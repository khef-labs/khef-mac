/**
 * Shared snapshot utilities.
 * current_snapshot is always computed from memory_snapshots, not stored.
 */

import { createHash } from 'crypto';
import { query } from '../db/client';
import type { PoolClient } from 'pg';

/**
 * Compute the current snapshot number for a memory.
 * Returns MAX(snapshot_number) + 1, or 1 if no snapshots exist.
 *
 * When a transaction client is passed, locks the parent memories row
 * so concurrent PATCHes don't race to assign the same snapshot_number
 * and collide on the (memory_id, snapshot_number) unique constraint.
 */
export async function getCurrentSnapshot(memoryId: string, client?: PoolClient): Promise<number> {
  if (client) {
    await client.query('SELECT 1 FROM memories WHERE id = $1 FOR UPDATE', [memoryId]);
  }
  const sql = 'SELECT COALESCE(MAX(snapshot_number), 0) + 1 AS current FROM memory_snapshots WHERE memory_id = $1';
  if (client) {
    const result = await client.query<{ current: number }>(sql, [memoryId]);
    return result.rows[0].current;
  }
  const result = await query<{ current: number }>(sql, [memoryId]);
  return result[0].current;
}

export type SnapshotSource =
  | 'manual'
  | 'external-sync'
  | 'pre-sync'
  | 'pre-restore'
  | 'pre-update';

/**
 * Save a snapshot of a memory's current content (and optionally comments).
 * Skips if the memory doesn't exist. Returns true if a snapshot was created.
 */
export async function saveSnapshot(
  memoryId: string,
  source: SnapshotSource = 'manual',
  client?: PoolClient,
): Promise<boolean> {
  const q = client
    ? (sql: string, params: any[]) => client.query(sql, params).then(r => r.rows)
    : query;

  const rows = await q('SELECT content FROM memories WHERE id = $1', [memoryId]);
  if (!rows.length) return false;

  const currentContent = (rows[0] as any).content as string;
  const snapNum = await getCurrentSnapshot(memoryId, client);
  const contentHash = createHash('sha256').update(currentContent).digest('hex').slice(0, 16);

  // Capture comments if they exist
  const comments = await q(
    `SELECT id, content, anchor_text, anchor_prefix, anchor_suffix, status, author, parent_comment_id, created_at
     FROM comments WHERE entity_type = 'memory' AND entity_id = $1 ORDER BY created_at`,
    [memoryId]
  );

  await q(
    `INSERT INTO memory_snapshots (memory_id, snapshot_number, content, content_hash, source, comments_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [memoryId, snapNum, currentContent, contentHash, source, JSON.stringify(comments)]
  );

  return true;
}

/**
 * Save a snapshot only if the proposed `newContent` differs from the memory's
 * current content. Used by content-changing routes to auto-snapshot the
 * "pre-update" state without churning a snapshot per metadata-only call or
 * per write that happens to set content to its existing value.
 *
 * Returns true if a snapshot was created, false if skipped.
 */
export async function saveSnapshotIfContentChanged(
  memoryId: string,
  newContent: string,
  source: SnapshotSource = 'pre-update',
  client?: PoolClient,
): Promise<boolean> {
  const q = client
    ? (sql: string, params: any[]) => client.query(sql, params).then(r => r.rows)
    : query;

  const rows = await q('SELECT content FROM memories WHERE id = $1', [memoryId]);
  if (!rows.length) return false;

  const currentContent = (rows[0] as any).content as string;
  if (currentContent === newContent) {
    return false;
  }

  return saveSnapshot(memoryId, source, client);
}
