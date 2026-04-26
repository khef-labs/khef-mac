/**
 * In-memory job manager for kvec source code embedding.
 *
 * Runs embed jobs sequentially (one at a time) using the @khef/kvec
 * ingestDirectory function. Jobs are stored in-memory — no DB table needed.
 * Supports progress tracking, cancellation, and batched processing.
 */

import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import { workerLogger } from '../lib/logger';
import { getOrCreateSourceCollection, getOrCreateCommitsCollection, getEmbedServerUrl } from './kvec-service';
import { ingestDirectory, ingestCommits } from '@khef/kvec';
import type { IngestResult } from '@khef/kvec';

const log = workerLogger.child({ component: 'kvec-embed-worker' });

const MAX_COMPLETED_JOBS = 50;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_BATCH_DELAY_MS = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbedJobProgress {
  filesProcessed: number;
  filesSkipped: number;
  filesErrored: number;
  chunksCreated: number;
  totalFiles: number;
}

export interface EmbedJob {
  id: string;
  jobType: 'source' | 'commits';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  path: string;
  extensions: string[];
  skipCommits: boolean;
  commitOpts?: { limit?: number; since?: string; until?: string; branch?: string };
  batchSize: number;
  batchDelayMs: number;
  progress: EmbedJobProgress;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const jobs = new Map<string, EmbedJob>();
const abortControllers = new Map<string, AbortController>();
const jobQueue: string[] = []; // IDs of queued jobs
let isProcessing = false;

// ---------------------------------------------------------------------------
// Queue processor
// ---------------------------------------------------------------------------

async function processQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  while (jobQueue.length > 0) {
    const jobId = jobQueue.shift()!;
    const job = jobs.get(jobId);
    if (!job || job.status !== 'queued') continue;

    await executeJob(job);
  }

  isProcessing = false;
}

async function executeJob(job: EmbedJob): Promise<void> {
  job.status = 'running';
  job.startedAt = new Date().toISOString();

  const controller = new AbortController();
  abortControllers.set(job.id, controller);

  log.info({ jobId: job.id, jobType: job.jobType, path: job.path, batchSize: job.batchSize }, 'Starting embed job');

  try {
    if (job.jobType === 'commits') {
      await executeCommitJob(job, controller);
    } else {
      await executeSourceJob(job, controller);
    }
  } catch (err: any) {
    job.status = controller.signal.aborted ? 'cancelled' : 'failed';
    job.error = err.message;
    log.error({ jobId: job.id, err }, 'Embed job failed');
  } finally {
    job.completedAt = new Date().toISOString();
    abortControllers.delete(job.id);
    evictOldJobs();
  }
}

async function executeSourceJob(job: EmbedJob, controller: AbortController): Promise<void> {
  const collection = await getOrCreateSourceCollection();

  const result = await ingestDirectory(collection, job.path, {
    extensions: job.extensions.length > 0 ? job.extensions : undefined,
    batchSize: job.batchSize,
    batchDelayMs: job.batchDelayMs,
    signal: controller.signal,
    onProgress: (stats: IngestResult & { totalFiles: number }) => {
      job.progress = {
        filesProcessed: stats.filesProcessed,
        filesSkipped: stats.filesSkipped,
        filesErrored: stats.filesErrored,
        chunksCreated: stats.chunksCreated,
        totalFiles: stats.totalFiles,
      };
    },
  });

  if (controller.signal.aborted) {
    job.status = 'cancelled';
    log.info({ jobId: job.id, progress: job.progress }, 'Embed job cancelled');
    return;
  }

  job.progress = {
    filesProcessed: result.filesProcessed,
    filesSkipped: result.filesSkipped,
    filesErrored: result.filesErrored,
    chunksCreated: result.chunksCreated,
    totalFiles: job.progress.totalFiles,
  };
  log.info({ jobId: job.id, progress: job.progress, durationMs: result.durationMs }, 'Source embed completed');

  // Auto-index commits unless opted out
  if (!job.skipCommits && !controller.signal.aborted) {
    try {
      const commitsCollection = await getOrCreateCommitsCollection();
      const commitResult = await ingestCommits(commitsCollection, job.path, {
        batchSize: job.batchSize,
        batchDelayMs: job.batchDelayMs,
        signal: controller.signal,
        ...job.commitOpts,
      });
      job.progress.chunksCreated += commitResult.chunksCreated;
      log.info({
        jobId: job.id,
        commitsProcessed: commitResult.filesProcessed,
        commitsSkipped: commitResult.filesSkipped,
        commitChunks: commitResult.chunksCreated,
        durationMs: commitResult.durationMs,
      }, 'Commit embed completed');
    } catch (err: any) {
      // Commit indexing failure is non-fatal for a source job
      log.warn({ jobId: job.id, err: err.message }, 'Commit indexing failed (non-fatal)');
    }
  }

  job.status = 'completed';
}

async function executeCommitJob(job: EmbedJob, controller: AbortController): Promise<void> {
  const commitsCollection = await getOrCreateCommitsCollection();

  const result = await ingestCommits(commitsCollection, job.path, {
    batchSize: job.batchSize,
    batchDelayMs: job.batchDelayMs,
    signal: controller.signal,
    ...job.commitOpts,
    onProgress: (stats: IngestResult & { totalCommits: number }) => {
      job.progress = {
        filesProcessed: stats.filesProcessed,
        filesSkipped: stats.filesSkipped,
        filesErrored: stats.filesErrored,
        chunksCreated: stats.chunksCreated,
        totalFiles: (stats as any).totalCommits ?? 0,
      };
    },
  });

  if (controller.signal.aborted) {
    job.status = 'cancelled';
    log.info({ jobId: job.id, progress: job.progress }, 'Commit embed job cancelled');
  } else {
    job.status = 'completed';
    job.progress = {
      filesProcessed: result.filesProcessed,
      filesSkipped: result.filesSkipped,
      filesErrored: result.filesErrored,
      chunksCreated: result.chunksCreated,
      totalFiles: job.progress.totalFiles,
    };
    log.info({ jobId: job.id, progress: job.progress, durationMs: result.durationMs }, 'Commit embed job completed');
  }
}

function evictOldJobs(): void {
  const completed = [...jobs.values()]
    .filter((j) => j.status !== 'queued' && j.status !== 'running')
    .sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''));

  while (completed.length > MAX_COMPLETED_JOBS) {
    const oldest = completed.shift()!;
    jobs.delete(oldest.id);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function validatePath(inputPath: string): void {
  try {
    const stat = statSync(inputPath);
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error('Path must be a file or directory');
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(`Path not found: ${inputPath}`);
    }
    throw err;
  }
}

function enqueueJob(job: EmbedJob): EmbedJob {
  jobs.set(job.id, job);
  jobQueue.push(job.id);
  processQueue().catch((err) => {
    log.error({ err }, 'Queue processing error');
  });
  return job;
}

export function startEmbedJob(params: {
  path: string;
  extensions?: string[];
  skipCommits?: boolean;
  commitOpts?: { limit?: number; since?: string; until?: string; branch?: string };
  batchSize?: number;
  batchDelayMs?: number;
}): EmbedJob {
  validatePath(params.path);

  return enqueueJob({
    id: randomUUID(),
    jobType: 'source',
    status: 'queued',
    path: params.path,
    extensions: normalizeExtensions(params.extensions ?? []),
    skipCommits: params.skipCommits ?? false,
    commitOpts: params.commitOpts,
    batchSize: params.batchSize ?? DEFAULT_BATCH_SIZE,
    batchDelayMs: params.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS,
    progress: {
      filesProcessed: 0,
      filesSkipped: 0,
      filesErrored: 0,
      chunksCreated: 0,
      totalFiles: 0,
    },
  });
}

export function startCommitEmbedJob(params: {
  path: string;
  limit?: number;
  since?: string;
  until?: string;
  branch?: string;
  batchSize?: number;
  batchDelayMs?: number;
}): EmbedJob {
  validatePath(params.path);

  return enqueueJob({
    id: randomUUID(),
    jobType: 'commits',
    status: 'queued',
    path: params.path,
    extensions: [],
    skipCommits: false,
    commitOpts: {
      limit: params.limit,
      since: params.since,
      until: params.until,
      branch: params.branch,
    },
    batchSize: params.batchSize ?? DEFAULT_BATCH_SIZE,
    batchDelayMs: params.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS,
    progress: {
      filesProcessed: 0,
      filesSkipped: 0,
      filesErrored: 0,
      chunksCreated: 0,
      totalFiles: 0,
    },
  });
}

function normalizeExtensions(extensions: string[]): string[] {
  return [...new Set(
    extensions
      .map((ext) => ext.trim().toLowerCase())
      .filter((ext) => ext.length > 0)
      .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
  )];
}

export function getJob(id: string): EmbedJob | undefined {
  return jobs.get(id);
}

export function listJobs(): EmbedJob[] {
  return [...jobs.values()].sort((a, b) => {
    // Running/queued first, then by most recent
    const statusOrder = { running: 0, queued: 1, completed: 2, failed: 3, cancelled: 4 };
    const diff = statusOrder[a.status] - statusOrder[b.status];
    if (diff !== 0) return diff;
    return (b.startedAt ?? b.id).localeCompare(a.startedAt ?? a.id);
  });
}

export function cancelJob(id: string): EmbedJob | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;

  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.completedAt = new Date().toISOString();
    const qIdx = jobQueue.indexOf(id);
    if (qIdx !== -1) jobQueue.splice(qIdx, 1);
    return job;
  }

  if (job.status === 'running') {
    const controller = abortControllers.get(id);
    if (controller) {
      controller.abort();
    }
    // Status will be set to 'cancelled' in the executeJob catch/finally
    return job;
  }

  return job;
}

export function deleteJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  // Don't allow deleting running/queued jobs — cancel first
  if (job.status === 'running' || job.status === 'queued') return false;
  jobs.delete(id);
  return true;
}

export async function checkEmbedServerHealth(): Promise<{
  available: boolean;
  model?: string;
  dimensions?: number;
  error?: string;
}> {
  const url = getEmbedServerUrl();
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return { available: false, error: `HTTP ${response.status}` };
    }
    const data = await response.json() as { status: string; model: string; dimensions: number };
    return { available: true, model: data.model, dimensions: data.dimensions };
  } catch (err: any) {
    return { available: false, error: err.message };
  }
}
