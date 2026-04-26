/**
 * Kvec auto-embed scheduler.
 *
 * Every 30 minutes, scans all enabled auto-embed configs, checks for new
 * commits since the last known hash, and queues up to 3 embed jobs
 * (staggered, sequential via the existing embed worker queue).
 *
 * Supports both 'commits' (git history) and 'source' (file content) job types.
 * Both use the branch HEAD commit hash for change detection.
 */

import { execFileSync } from 'child_process';
import { query, querySingle } from '../db/client';
import { startCommitEmbedJob, startEmbedJob } from './kvec-embed-worker';
import { logger } from '../lib/logger';

const log = logger.child({ component: 'kvec-auto-embed' });

const SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_JOBS_PER_TICK = 3;

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutoEmbedJobType = 'commits' | 'source';

export interface AutoEmbedConfig {
  id: string;
  repo_path: string;
  branch: string;
  job_type: AutoEmbedJobType;
  enabled: boolean;
  batch_delay_ms: number;
  last_run_at: string | null;
  last_commit_hash: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listAutoEmbedConfigs(): Promise<AutoEmbedConfig[]> {
  return query<AutoEmbedConfig>(
    `SELECT * FROM kvec_auto_embed ORDER BY created_at DESC`
  );
}

export async function getAutoEmbedConfig(id: string): Promise<AutoEmbedConfig | null> {
  return querySingle<AutoEmbedConfig>(
    `SELECT * FROM kvec_auto_embed WHERE id = $1`,
    [id]
  );
}

export async function createAutoEmbedConfig(params: {
  repo_path: string;
  branch?: string;
  job_type?: AutoEmbedJobType;
  batch_delay_ms?: number;
}): Promise<AutoEmbedConfig> {
  const { repo_path, branch = 'main', job_type = 'commits', batch_delay_ms = 1000 } = params;

  const row = await querySingle<AutoEmbedConfig>(
    `INSERT INTO kvec_auto_embed (repo_path, branch, job_type, batch_delay_ms)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [repo_path, branch, job_type, batch_delay_ms]
  );

  if (!row) throw new Error('Failed to create auto-embed config');
  log.info({ id: row.id, repo_path, branch, job_type }, 'Auto-embed config created');
  return row;
}

export async function updateAutoEmbedConfig(
  id: string,
  params: { enabled?: boolean; batch_delay_ms?: number; branch?: string }
): Promise<AutoEmbedConfig | null> {
  const sets: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (params.enabled !== undefined) {
    sets.push(`enabled = $${idx++}`);
    values.push(params.enabled);
  }
  if (params.batch_delay_ms !== undefined) {
    sets.push(`batch_delay_ms = $${idx++}`);
    values.push(params.batch_delay_ms);
  }
  if (params.branch !== undefined) {
    sets.push(`branch = $${idx++}`);
    values.push(params.branch);
  }

  if (sets.length === 0) return getAutoEmbedConfig(id);

  sets.push(`updated_at = NOW()`);
  values.push(id);

  return querySingle<AutoEmbedConfig>(
    `UPDATE kvec_auto_embed SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
}

export async function deleteAutoEmbedConfig(id: string): Promise<boolean> {
  const result = await querySingle<{ id: string }>(
    `DELETE FROM kvec_auto_embed WHERE id = $1 RETURNING id`,
    [id]
  );
  return !!result;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Get the latest commit hash on a branch for a repo.
 * Returns null if the repo or branch doesn't exist.
 */
function getLatestCommitHash(repoPath: string, branch: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', branch], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Check if there are new commits on a branch since a given commit hash.
 * Returns the count of new commits, or -1 if the hash is invalid/missing.
 */
function countNewCommits(repoPath: string, branch: string, sinceHash: string): number {
  try {
    const output = execFileSync(
      'git',
      ['rev-list', '--count', `${sinceHash}..${branch}`],
      { cwd: repoPath, encoding: 'utf-8', timeout: 5000 }
    ).trim();
    return parseInt(output, 10) || 0;
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Job dispatching
// ---------------------------------------------------------------------------

/**
 * Start the appropriate embed job based on config type.
 */
function dispatchEmbedJob(config: AutoEmbedConfig, opts?: { since?: string }): void {
  if (config.job_type === 'source') {
    startEmbedJob({
      path: config.repo_path,
      skipCommits: true,
      batchSize: 20,
      batchDelayMs: config.batch_delay_ms,
    });
  } else {
    startCommitEmbedJob({
      path: config.repo_path,
      branch: config.branch,
      since: opts?.since,
      batchSize: 20,
      batchDelayMs: config.batch_delay_ms,
    });
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Run a single scheduler tick: scan configs, find changes, queue jobs.
 */
export async function runAutoEmbedTick(): Promise<{ queued: number; checked: number; errors: number }> {
  const configs = await query<AutoEmbedConfig>(
    `SELECT * FROM kvec_auto_embed WHERE enabled = true ORDER BY last_run_at ASC NULLS FIRST`
  );

  log.info({ configCount: configs.length }, 'Auto-embed tick started');

  let queued = 0;
  let checked = 0;
  let errors = 0;

  for (const config of configs) {
    if (queued >= MAX_JOBS_PER_TICK) break;

    checked++;

    try {
      const latestHash = getLatestCommitHash(config.repo_path, config.branch);
      if (!latestHash) {
        const errorMsg = `Cannot resolve branch "${config.branch}" in ${config.repo_path}`;
        log.warn({ configId: config.id, repo: config.repo_path, branch: config.branch }, errorMsg);
        await query(
          `UPDATE kvec_auto_embed SET last_error = $1, updated_at = NOW() WHERE id = $2`,
          [errorMsg, config.id]
        );
        errors++;
        continue;
      }

      // No previous hash = first run, embed everything
      if (!config.last_commit_hash) {
        log.info(
          { configId: config.id, repo: config.repo_path, branch: config.branch, jobType: config.job_type },
          'First run — embedding all content'
        );
        dispatchEmbedJob(config);

        await query(
          `UPDATE kvec_auto_embed
           SET last_run_at = NOW(), last_commit_hash = $1, last_error = NULL, updated_at = NOW()
           WHERE id = $2`,
          [latestHash, config.id]
        );
        queued++;
        continue;
      }

      // Check for new commits (change detection for both types)
      if (latestHash === config.last_commit_hash) {
        continue; // No changes
      }

      const newCount = countNewCommits(config.repo_path, config.branch, config.last_commit_hash);
      if (newCount <= 0) {
        continue; // No new commits (or hash was force-pushed away)
      }

      log.info(
        { configId: config.id, repo: config.repo_path, branch: config.branch, jobType: config.job_type, newCommits: newCount },
        'New commits detected — queuing embed job'
      );

      // For commits, use last_run_at as since date to only embed new ones
      const sinceDate = config.job_type === 'commits' && config.last_run_at
        ? new Date(config.last_run_at).toISOString()
        : undefined;

      dispatchEmbedJob(config, { since: sinceDate });

      await query(
        `UPDATE kvec_auto_embed
         SET last_run_at = NOW(), last_commit_hash = $1, last_error = NULL, updated_at = NOW()
         WHERE id = $2`,
        [latestHash, config.id]
      );
      queued++;
    } catch (err: any) {
      log.error({ configId: config.id, err }, 'Auto-embed config check failed');
      await query(
        `UPDATE kvec_auto_embed SET last_error = $1, updated_at = NOW() WHERE id = $2`,
        [err.message, config.id]
      ).catch(() => {});
      errors++;
    }
  }

  log.info({ queued, checked, errors }, 'Auto-embed tick completed');
  return { queued, checked, errors };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startAutoEmbedScheduler(): void {
  if (schedulerInterval) return;

  log.info({ intervalMs: SCAN_INTERVAL_MS }, 'Auto-embed scheduler started');
  // Don't run on startup — wait for the first interval
  schedulerInterval = setInterval(() => {
    runAutoEmbedTick().catch((err) => {
      log.error({ err }, 'Auto-embed tick failed');
    });
  }, SCAN_INTERVAL_MS);
}

export function stopAutoEmbedScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    log.info('Auto-embed scheduler stopped');
  }
}
