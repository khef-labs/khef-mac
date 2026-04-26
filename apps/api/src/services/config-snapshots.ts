/**
 * Config snapshot management for assistant configurations
 *
 * Follows the memory snapshots pattern with sequential snapshot numbers.
 * current_snapshot is computed from config_snapshots, not stored.
 */

import { createHash } from 'node:crypto';
import { query, querySingle } from '../db/client';

// ── Types ────────────────────────────────────────────────────────────

export interface ConfigSnapshotSummary {
  snapshot_number: number;
  size: number | null;
  content_hash: string;
  content_type: 'json' | 'markdown' | 'toml' | null;
  source: string;
  created_at: Date;
}

export interface ConfigSnapshot {
  id: string;
  snapshot_number: number;
  content: string;
  content_hash: string;
  content_type: 'json' | 'markdown' | 'toml' | null;
  content_json: Record<string, unknown> | null;
  source: string;
  size: number | null;
  created_at: Date;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of content
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Compute the current snapshot number for a config.
 * Returns MAX(snapshot_number), or 0 if no snapshots exist.
 */
export async function getConfigCurrentSnapshot(configId: string): Promise<number> {
  const result = await querySingle<{ current: number }>(
    'SELECT COALESCE(MAX(snapshot_number), 0) AS current FROM config_snapshots WHERE config_id = $1',
    [configId]
  );
  return result?.current ?? 0;
}

// ── Snapshot Management ──────────────────────────────────────────────

/**
 * Create a new config snapshot
 * Returns the new snapshot number, or current if content unchanged (unless force=true)
 * For JSON content_type, validates, normalizes, and stores as JSONB
 */
export async function createConfigSnapshot(
  configId: string,
  content: string,
  source: 'manual' | 'import' | 'pre-sync' = 'manual',
  force = false,
  contentType?: 'json' | 'markdown' | 'toml'
): Promise<number> {
  let normalizedContent = content;
  let contentJson: Record<string, unknown> | null = null;

  // For JSON content, validate, normalize, and prepare JSONB value
  if (contentType === 'json') {
    try {
      const parsed = JSON.parse(content);
      normalizedContent = JSON.stringify(parsed, null, 2);
      contentJson = parsed;
    } catch (e: any) {
      throw new Error(`Invalid JSON content: ${e.message}`);
    }
  }

  const contentHash = computeContentHash(normalizedContent);
  const size = normalizedContent.length;

  // Get current snapshot number (computed from max)
  const currentSnapshot = await getConfigCurrentSnapshot(configId);

  // Check if content actually changed from last snapshot (skip check if force=true)
  if (!force) {
    const lastSnapshot = await querySingle<{ content_hash: string }>(
      `SELECT content_hash FROM config_snapshots
       WHERE config_id = $1
       ORDER BY snapshot_number DESC LIMIT 1`,
      [configId]
    );

    if (lastSnapshot?.content_hash === contentHash) {
      // Content hasn't changed, don't create new snapshot
      return currentSnapshot;
    }
  }

  // Create the new snapshot
  const newSnapshotNumber = currentSnapshot + 1;

  await query(
    `INSERT INTO config_snapshots (config_id, snapshot_number, content, content_hash, source, size, content_type, content_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (config_id, snapshot_number) DO NOTHING`,
    [configId, newSnapshotNumber, normalizedContent, contentHash, source, size, contentType ?? null, contentJson ? JSON.stringify(contentJson) : null]
  );

  return newSnapshotNumber;
}

/**
 * Get all snapshots of a config
 */
export async function getConfigSnapshots(
  configId: string
): Promise<ConfigSnapshotSummary[]> {
  const snapshots = await query<ConfigSnapshotSummary>(
    `SELECT snapshot_number, size, content_hash, content_type, source, created_at
     FROM config_snapshots
     WHERE config_id = $1
     ORDER BY snapshot_number DESC`,
    [configId]
  );

  return snapshots;
}

/**
 * Get a specific snapshot of a config
 */
export async function getConfigSnapshot(
  configId: string,
  snapshotNumber: number
): Promise<ConfigSnapshot | null> {
  const result = await querySingle<ConfigSnapshot>(
    `SELECT id, snapshot_number, content, content_hash, content_type, content_json, source, size, created_at
     FROM config_snapshots
     WHERE config_id = $1 AND snapshot_number = $2`,
    [configId, snapshotNumber]
  );

  return result;
}

/**
 * Delete a specific config snapshot
 * Cannot delete the only remaining snapshot
 */
export async function deleteConfigSnapshot(
  configId: string,
  snapshotNumber: number
): Promise<{ deleted: boolean; error?: string }> {
  // Get snapshot count
  const countResult = await querySingle<{ count: string }>(
    'SELECT COUNT(*) as count FROM config_snapshots WHERE config_id = $1',
    [configId]
  );
  const snapshotCount = parseInt(countResult?.count ?? '0', 10);

  if (snapshotCount <= 1) {
    return { deleted: false, error: 'Cannot delete the only remaining snapshot' };
  }

  // Check snapshot exists
  const exists = await querySingle<{ snapshot_number: number }>(
    'SELECT snapshot_number FROM config_snapshots WHERE config_id = $1 AND snapshot_number = $2',
    [configId, snapshotNumber]
  );

  if (!exists) {
    return { deleted: false, error: 'Snapshot not found' };
  }

  // Delete the snapshot
  await query(
    'DELETE FROM config_snapshots WHERE config_id = $1 AND snapshot_number = $2',
    [configId, snapshotNumber]
  );

  return { deleted: true };
}

/**
 * Restore a specific snapshot as current
 * Creates a pre-restore snapshot of current content first
 */
export async function restoreConfigSnapshot(
  configId: string,
  snapshotNumber: number
): Promise<{ restored: boolean; newSnapshot?: number; error?: string }> {
  // Get the snapshot to restore
  const snapshotToRestore = await getConfigSnapshot(configId, snapshotNumber);
  if (!snapshotToRestore) {
    return { restored: false, error: 'Snapshot not found' };
  }

  // Get current config state
  const currentConfig = await querySingle<{ content: string }>(
    'SELECT content FROM configs WHERE id = $1',
    [configId]
  );

  if (!currentConfig) {
    return { restored: false, error: 'Config not found' };
  }

  // Get current snapshot number (computed)
  const currentSnapshot = await getConfigCurrentSnapshot(configId);

  // If already at this snapshot, nothing to do
  if (currentSnapshot === snapshotNumber) {
    return { restored: true, newSnapshot: snapshotNumber };
  }

  // Create a pre-restore snapshot of current content (if different)
  await createConfigSnapshot(configId, currentConfig.content, 'pre-sync');

  // Now create the restored snapshot
  const newSnapshot = await createConfigSnapshot(configId, snapshotToRestore.content, 'manual');

  // Update config content
  await query(
    `UPDATE configs SET content = $1, file_hash = $2, updated_at = NOW()
     WHERE id = $3`,
    [snapshotToRestore.content, snapshotToRestore.content_hash, configId]
  );

  return { restored: true, newSnapshot };
}

/**
 * Get snapshot count for a config
 */
export async function getConfigSnapshotCount(configId: string): Promise<number> {
  const result = await querySingle<{ count: string }>(
    'SELECT COUNT(*) as count FROM config_snapshots WHERE config_id = $1',
    [configId]
  );
  return parseInt(result?.count ?? '0', 10);
}
