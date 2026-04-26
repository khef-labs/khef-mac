/**
 * In-memory job manager for document embedding (markdown, PDF, text files).
 *
 * Supports single-file and directory ingestion into the kvec-docs collection.
 * Uses Collection.ingestContent() for each document. PDF text extraction via
 * pdftotext CLI (poppler).
 */

import { randomUUID } from 'crypto';
import { statSync, readdirSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { workerLogger } from '../lib/logger';
import { getOrCreateDocsCollection } from './kvec-service';

const log = workerLogger.child({ component: 'kvec-doc-worker' });

const MAX_COMPLETED_JOBS = 50;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_BATCH_DELAY_MS = 200;

const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.pdf']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocJobProgress {
  filesProcessed: number;
  filesSkipped: number;
  filesErrored: number;
  chunksCreated: number;
  totalFiles: number;
}

export interface DocEmbedJob {
  id: string;
  jobType: 'doc' | 'doc-directory';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  path: string;
  extensions: string[];
  projectHandle?: string;
  tags?: string[];
  title?: string;
  batchSize: number;
  batchDelayMs: number;
  progress: DocJobProgress;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const jobs = new Map<string, DocEmbedJob>();
const abortControllers = new Map<string, AbortController>();
const jobQueue: string[] = [];
let isProcessing = false;

// ---------------------------------------------------------------------------
// PDF extraction
// ---------------------------------------------------------------------------

function extractPdfText(filePath: string): string {
  try {
    return execSync(`pdftotext -layout "${filePath}" -`, {
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err: any) {
    if (err.message?.includes('ENOENT') || err.message?.includes('not found')) {
      throw new Error('pdftotext not installed. Install poppler: brew install poppler');
    }
    throw new Error(`PDF extraction failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function discoverFiles(dirPath: string, extensions: string[]): string[] {
  const allowedExts = extensions.length > 0
    ? new Set(extensions)
    : SUPPORTED_EXTENSIONS;

  const results: string[] = [];

  function walk(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (allowedExts.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(dirPath);
  return results.sort();
}

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

async function executeJob(job: DocEmbedJob): Promise<void> {
  job.status = 'running';
  job.startedAt = new Date().toISOString();

  const controller = new AbortController();
  abortControllers.set(job.id, controller);

  log.info({ jobId: job.id, jobType: job.jobType, path: job.path }, 'Starting doc embed job');

  try {
    const collection = await getOrCreateDocsCollection();

    // Discover files
    let files: string[];
    if (job.jobType === 'doc') {
      files = [job.path];
    } else {
      files = discoverFiles(job.path, job.extensions);
    }

    job.progress.totalFiles = files.length;

    // Process files in batches
    let processed = 0;
    for (const filePath of files) {
      if (controller.signal.aborted) {
        job.status = 'cancelled';
        log.info({ jobId: job.id, progress: job.progress }, 'Doc embed job cancelled');
        return;
      }

      try {
        const ext = path.extname(filePath).toLowerCase();
        let content: string;
        let language: string;

        if (ext === '.pdf') {
          content = extractPdfText(filePath);
          language = 'text';
        } else {
          content = readFileSync(filePath, 'utf-8');
          language = ext === '.md' ? 'markdown' : 'text';
        }

        if (!content.trim()) {
          job.progress.filesSkipped++;
          continue;
        }

        const metadata: Record<string, unknown> = {
          file_type: ext.replace('.', ''),
          source_path: filePath,
        };
        if (job.projectHandle) metadata.project_handle = job.projectHandle;
        if (job.tags && job.tags.length > 0) metadata.tags = job.tags;
        if (job.title && job.jobType === 'doc') metadata.title = job.title;

        const documentId = filePath;
        const chunksCreated = await collection.ingestContent(documentId, content, {
          language,
          metadata,
        });

        if (chunksCreated === 0) {
          job.progress.filesSkipped++;
        } else {
          job.progress.filesProcessed++;
          job.progress.chunksCreated += chunksCreated;
        }
      } catch (err: any) {
        job.progress.filesErrored++;
        log.warn({ jobId: job.id, file: filePath, err: err.message }, 'Failed to embed document');
      }

      processed++;

      // Batch pacing
      if (job.batchDelayMs > 0 && job.batchSize > 0 && processed % job.batchSize === 0 && processed < files.length) {
        await new Promise((resolve) => setTimeout(resolve, job.batchDelayMs));
      }
    }

    job.status = 'completed';
    log.info({ jobId: job.id, progress: job.progress }, 'Doc embed job completed');
  } catch (err: any) {
    job.status = controller.signal.aborted ? 'cancelled' : 'failed';
    job.error = err.message;
    log.error({ jobId: job.id, err }, 'Doc embed job failed');
  } finally {
    job.completedAt = new Date().toISOString();
    abortControllers.delete(job.id);
    evictOldJobs();
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
// Path validation
// ---------------------------------------------------------------------------

function validatePath(inputPath: string): 'file' | 'directory' {
  try {
    const stat = statSync(inputPath);
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'directory';
    throw new Error('Path must be a file or directory');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(`Path not found: ${inputPath}`);
    }
    throw err;
  }
}

function normalizeExtensions(extensions: string[]): string[] {
  return [...new Set(
    extensions
      .map((ext) => ext.trim().toLowerCase())
      .filter((ext) => ext.length > 0)
      .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
  )];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function enqueueJob(job: DocEmbedJob): DocEmbedJob {
  jobs.set(job.id, job);
  jobQueue.push(job.id);
  processQueue().catch((err) => {
    log.error({ err }, 'Doc queue processing error');
  });
  return job;
}

export function startDocEmbedJob(params: {
  path: string;
  extensions?: string[];
  projectHandle?: string;
  tags?: string[];
  title?: string;
  batchSize?: number;
  batchDelayMs?: number;
}): DocEmbedJob {
  const pathType = validatePath(params.path);

  // Validate single-file extension
  if (pathType === 'file') {
    const ext = path.extname(params.path).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported file type: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`);
    }
  }

  return enqueueJob({
    id: randomUUID(),
    jobType: pathType === 'file' ? 'doc' : 'doc-directory',
    status: 'queued',
    path: params.path,
    extensions: normalizeExtensions(params.extensions ?? []),
    projectHandle: params.projectHandle,
    tags: params.tags,
    title: params.title,
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

export function getDocJob(id: string): DocEmbedJob | undefined {
  return jobs.get(id);
}

export function listDocJobs(): DocEmbedJob[] {
  return [...jobs.values()].sort((a, b) => {
    const statusOrder = { running: 0, queued: 1, completed: 2, failed: 3, cancelled: 4 };
    const diff = statusOrder[a.status] - statusOrder[b.status];
    if (diff !== 0) return diff;
    return (b.startedAt ?? b.id).localeCompare(a.startedAt ?? a.id);
  });
}

export function cancelDocJob(id: string): DocEmbedJob | undefined {
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
    if (controller) controller.abort();
    return job;
  }

  return job;
}

export function deleteDocJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === 'running' || job.status === 'queued') return false;
  jobs.delete(id);
  return true;
}
