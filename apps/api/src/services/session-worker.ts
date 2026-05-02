/**
 * Background worker for session sync.
 *
 * Two independent loops:
 *   - Embedding sync: every EMBEDDING_INTERVAL_MS. Walks sessions that still
 *     need vector embeddings. Time-insensitive — just keeps the kvec index
 *     current.
 *   - Polled reconciliation: every `sessions.polledSyncIntervalMinutes`
 *     setting (default 60). Does a full syncAllSessions pass to catch
 *     anything the push-based session-watcher missed (stale files, watcher
 *     downtime, sessions outside the active window).
 */

import { workerLogger } from '../lib/logger';
import { querySingle } from '../db/client';
import {
  syncAllSessions,
  syncAssistantSessions,
  loadSessionProjectMap,
  getSessionSyncStatus,
} from './session-sync';
import { syncSessionEmbeddings } from './session-embeddings';

const log = workerLogger.child({ component: 'session-worker' });

const EMBEDDING_INTERVAL_MS = 60_000; // 1 minute
const DEFAULT_POLLED_INTERVAL_MINUTES = 60;
const EMBEDDING_ASSISTANTS = ['claude-code', 'codex-cli'];

let embeddingInterval: NodeJS.Timeout | null = null;
let polledInterval: NodeJS.Timeout | null = null;
let isEmbeddingRunning = false;
let isPolledRunning = false;

async function loadPolledIntervalMs(): Promise<number> {
  const row = await querySingle<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'sessions.polledSyncIntervalMinutes'`
  );
  const parsed = row ? Number(row.value) : NaN;
  const minutes =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLLED_INTERVAL_MINUTES;
  return minutes * 60_000;
}

async function runEmbeddingPass(): Promise<void> {
  if (isEmbeddingRunning) {
    log.debug('Embedding pass still running, skipping');
    return;
  }
  isEmbeddingRunning = true;
  try {
    for (const handle of EMBEDDING_ASSISTANTS) {
      try {
        await syncSessionEmbeddings(handle);
      } catch (err) {
        log.error({ err, assistant: handle }, 'Error in session embedding sync');
      }
    }
  } finally {
    isEmbeddingRunning = false;
  }
}

async function runPolledReconciliation(): Promise<void> {
  if (isPolledRunning) {
    log.debug('Polled reconciliation still running, skipping');
    return;
  }
  isPolledRunning = true;
  try {
    await syncAllSessions();
  } catch (err) {
    log.error({ err }, 'Error in polled reconciliation');
  } finally {
    isPolledRunning = false;
  }
}

export async function startSessionSyncWorker(): Promise<void> {
  if (embeddingInterval || polledInterval) {
    log.info('Worker already running');
    return;
  }

  const polledIntervalMs = await loadPolledIntervalMs();
  log.info(
    { embeddingMs: EMBEDDING_INTERVAL_MS, polledMs: polledIntervalMs },
    'Worker started'
  );

  // Kick off both once at startup
  runPolledReconciliation();
  runEmbeddingPass();

  embeddingInterval = setInterval(runEmbeddingPass, EMBEDDING_INTERVAL_MS);
  polledInterval = setInterval(runPolledReconciliation, polledIntervalMs);
}

export function stopSessionSyncWorker(): void {
  if (embeddingInterval) {
    clearInterval(embeddingInterval);
    embeddingInterval = null;
  }
  if (polledInterval) {
    clearInterval(polledInterval);
    polledInterval = null;
  }
  log.info('Worker stopped');
}

export function isSessionWorkerRunning(): boolean {
  return embeddingInterval !== null || polledInterval !== null;
}

export async function triggerSessionSync(options?: { force?: boolean; assistant?: string }): Promise<{
  synced: number;
  updated: number;
  skipped: number;
  errors: number;
  chunks_created: number;
}> {
  if (options?.assistant) {
    const projectMap = await loadSessionProjectMap();
    return syncAssistantSessions(options.assistant, projectMap, { force: options.force });
  }
  return syncAllSessions(options);
}

export { getSessionSyncStatus };
