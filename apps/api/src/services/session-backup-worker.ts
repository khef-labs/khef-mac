/**
 * Background worker for session JSONL backup.
 *
 * Periodically copies Claude Code and Codex CLI session files to a
 * user-configured persistent location so they survive upstream pruning.
 * Runs on its own cadence, independent of the session sync worker.
 * Performs no DB queries — filesystem is the source of truth.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { workerLogger } from '../lib/logger';
import { query } from '../db/client';
import {
  SESSION_PATHS,
  findClaudeSessions,
  findCodexSessions,
} from './session-sync';

const log = workerLogger.child({ component: 'session-backup-worker' });

const DEFAULT_INTERVAL_MINUTES = 10;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;

let backupTimeout: NodeJS.Timeout | null = null;
let isRunning = false;
let isStopped = false;

interface BackupConfig {
  enabled: boolean;
  backupPath: string;
  intervalMinutes: number;
}

interface BackupResult {
  copied: number;
  skipped: number;
  errors: number;
}

/**
 * Expand a leading "~" to the user's home directory.
 */
function expandTilde(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return filepath.replace('~', os.homedir());
  }
  return filepath;
}

/**
 * Read backup settings from the DB.
 */
export async function loadBackupConfig(): Promise<BackupConfig> {
  try {
    const rows = await query<{ key: string; value: string }>(
      `SELECT key, value FROM settings WHERE key IN ('sessions.backupPath', 'sessions.backupEnabled', 'sessions.backupIntervalMinutes')`
    );
    const map: Record<string, string> = {};
    for (const row of rows) map[row.key] = row.value;
    const enabled = map['sessions.backupEnabled'] === 'true';
    const backupPath = (map['sessions.backupPath'] ?? '').trim();
    const parsed = parseInt(map['sessions.backupIntervalMinutes'] ?? '', 10);
    const intervalMinutes = Number.isFinite(parsed) && parsed > 0
      ? Math.min(Math.max(parsed, MIN_INTERVAL_MINUTES), MAX_INTERVAL_MINUTES)
      : DEFAULT_INTERVAL_MINUTES;
    return {
      enabled: enabled && backupPath.length > 0,
      backupPath,
      intervalMinutes,
    };
  } catch (err) {
    log.error({ err }, 'Failed to read backup settings');
    return { enabled: false, backupPath: '', intervalMinutes: DEFAULT_INTERVAL_MINUTES };
  }
}

/**
 * Compute destination path for a source file under the backup root.
 * Mirrors the source directory structure beneath <backupRoot>/<assistantHandle>/.
 */
function destinationFor(
  srcPath: string,
  backupRoot: string,
  assistantHandle: string
): string | null {
  const config = SESSION_PATHS[assistantHandle];
  if (!config) return null;

  const relativePath = path.relative(config.basePath, srcPath);
  if (relativePath.startsWith('..')) return null;

  const resolvedRoot = path.resolve(expandTilde(backupRoot));
  return path.join(resolvedRoot, assistantHandle, relativePath);
}

/**
 * Backup a single assistant's session files to the backup location.
 * Skips files whose destination already exists with the same size.
 * Errors on individual files are logged and do not stop the pass.
 */
async function backupAssistant(
  assistantHandle: string,
  backupRoot: string
): Promise<BackupResult> {
  const result: BackupResult = { copied: 0, skipped: 0, errors: 0 };

  const config = SESSION_PATHS[assistantHandle];
  if (!config) return result;

  const files = config.structure === 'project'
    ? findClaudeSessions(config.basePath)
    : findCodexSessions(config.basePath);

  for (const srcPath of files) {
    try {
      const destPath = destinationFor(srcPath, backupRoot, assistantHandle);
      if (!destPath) {
        result.errors++;
        continue;
      }

      const srcStat = fs.statSync(srcPath);

      // Fast skip: destination exists with same size (JSONL files are append-only)
      try {
        const destStat = fs.statSync(destPath);
        if (destStat.size === srcStat.size) {
          result.skipped++;
          continue;
        }
      } catch {
        // Destination missing — proceed with copy
      }

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      await fs.promises.copyFile(srcPath, destPath);
      result.copied++;
    } catch (err) {
      log.error({ err, srcPath, assistantHandle }, 'Failed to backup session file');
      result.errors++;
    }
  }

  return result;
}

async function runBackupCycle(): Promise<number> {
  const config = await loadBackupConfig();
  if (!config.enabled) return config.intervalMinutes;

  if (isRunning) {
    log.debug('Previous backup still running, skipping');
    return config.intervalMinutes;
  }

  isRunning = true;
  try {
    const total: BackupResult = { copied: 0, skipped: 0, errors: 0 };
    for (const handle of Object.keys(SESSION_PATHS)) {
      const result = await backupAssistant(handle, config.backupPath);
      total.copied += result.copied;
      total.skipped += result.skipped;
      total.errors += result.errors;
    }

    if (total.copied > 0 || total.errors > 0) {
      log.info(
        { copied: total.copied, skipped: total.skipped, errors: total.errors, backupPath: config.backupPath },
        'Session backup pass complete'
      );
    }
  } catch (err) {
    log.error({ err }, 'Error in backup cycle');
  } finally {
    isRunning = false;
  }

  return config.intervalMinutes;
}

function scheduleNext(delayMinutes: number): void {
  if (isStopped) return;
  const ms = delayMinutes * 60 * 1000;
  backupTimeout = setTimeout(async () => {
    const nextDelay = await runBackupCycle();
    scheduleNext(nextDelay);
  }, ms);
}

/**
 * Start the session backup background worker.
 * Uses a recursive setTimeout so interval changes pick up on the next cycle.
 */
export function startSessionBackupWorker(): void {
  if (backupTimeout) {
    log.info('Worker already running');
    return;
  }

  isStopped = false;
  log.info('Worker started');

  // First pass on start, then schedule subsequent cycles based on DB setting
  (async () => {
    const nextDelay = await runBackupCycle();
    scheduleNext(nextDelay);
  })();
}

/**
 * Stop the session backup background worker.
 */
export function stopSessionBackupWorker(): void {
  isStopped = true;
  if (backupTimeout) {
    clearTimeout(backupTimeout);
    backupTimeout = null;
    log.info('Worker stopped');
  }
}

/**
 * Trigger an immediate backup pass (ignores isRunning throttle guard).
 * Honors the enabled flag — returns a zero result when disabled.
 */
export async function triggerSessionBackup(): Promise<BackupResult> {
  const config = await loadBackupConfig();
  if (!config.enabled) return { copied: 0, skipped: 0, errors: 0 };

  const total: BackupResult = { copied: 0, skipped: 0, errors: 0 };
  for (const handle of Object.keys(SESSION_PATHS)) {
    const result = await backupAssistant(handle, config.backupPath);
    total.copied += result.copied;
    total.skipped += result.skipped;
    total.errors += result.errors;
  }
  return total;
}
