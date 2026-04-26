import { execSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import path from 'path';
import { Collection, IngestOptions } from './collection';
import { UploadEvent } from './types';

export interface IngestDirectoryOptions {
  /** File extensions to include (e.g., ['.ts', '.js']). If empty, includes all. */
  extensions?: string[];
  /** Max files to process (0 = no limit) */
  limit?: number;
  /** Log progress to console */
  verbose?: boolean;
  /** Called after each file with current cumulative stats */
  onProgress?: (stats: IngestResult & { totalFiles: number }) => void;
  /** AbortSignal — checked before each file to allow cancellation */
  signal?: AbortSignal;
  /** Files to process before yielding the event loop (0 = no batching) */
  batchSize?: number;
  /** Milliseconds to wait between batches (default: 200) */
  batchDelayMs?: number;
}

export interface IngestResult {
  filesProcessed: number;
  filesSkipped: number;
  filesErrored: number;
  chunksCreated: number;
  durationMs: number;
  errors: Array<{ file: string; error: string }>;
}

/**
 * Ingest all files from a directory into a collection.
 * Detects git repos automatically and uses git ls-files to respect .gitignore.
 */
export async function ingestDirectory(
  collection: Collection,
  dirPath: string,
  opts?: IngestDirectoryOptions
): Promise<IngestResult> {
  const startTime = Date.now();
  const absoluteDir = path.resolve(dirPath);
  const verbose = opts?.verbose ?? false;
  const extensions = normalizeExtensions(opts?.extensions ?? []);
  const limit = opts?.limit ?? 0;
  const onProgress = opts?.onProgress;
  const signal = opts?.signal;
  const batchSize = opts?.batchSize ?? 0;
  const batchDelayMs = opts?.batchDelayMs ?? 200;
  const inputStat = statSync(absoluteDir);

  if (inputStat.isFile()) {
    return ingestSingleFile(collection, absoluteDir, {
      verbose,
      signal,
      onProgress,
    });
  }

  // Detect git info
  const git = detectGit(absoluteDir);

  // Discover files
  let files: string[];
  if (git) {
    files = gitListFiles(absoluteDir);
    if (verbose) console.log(`Git repo: ${git.name} (${git.branch}@${git.commitHash.slice(0, 7)})`);
  } else {
    files = walkDirectory(absoluteDir);
    if (verbose) console.log(`Non-git directory: ${absoluteDir}`);
  }

  // Filter by extension
  if (extensions.length > 0) {
    files = files.filter((f) => extensions.includes(path.extname(f).toLowerCase()));
  }

  // Sort by file size ascending — process small/fast files first
  const baseDir = git ? absoluteDir : '';
  files.sort((a, b) => {
    try {
      const sizeA = statSync(git ? path.join(baseDir, a) : a).size;
      const sizeB = statSync(git ? path.join(baseDir, b) : b).size;
      return sizeA - sizeB;
    } catch {
      return 0;
    }
  });

  // Apply limit
  if (limit > 0 && files.length > limit) {
    files = files.slice(0, limit);
  }

  if (verbose) console.log(`Files to process: ${files.length}`);

  const result: IngestResult = {
    filesProcessed: 0,
    filesSkipped: 0,
    filesErrored: 0,
    chunksCreated: 0,
    durationMs: 0,
    errors: [],
  };

  let embeddedSincePause = 0;

  for (let i = 0; i < files.length; i++) {
    // Check for cancellation before each file
    if (signal?.aborted) {
      break;
    }

    const filePath = files[i];
    const absoluteFile = git ? path.join(absoluteDir, filePath) : filePath;

    try {
      const ingestOpts: IngestOptions = {};

      if (git) {
        ingestOpts.repoName = git.name;
        ingestOpts.repoRootPath = git.rootPath;
        ingestOpts.remoteUrl = git.remoteUrl;
        ingestOpts.branch = git.branch;
        ingestOpts.commitHash = git.commitHash;
      }

      const chunks = await collection.ingest(absoluteFile, ingestOpts);

      if (chunks === 0) {
        result.filesSkipped++;
      } else {
        result.filesProcessed++;
        result.chunksCreated += chunks;
        embeddedSincePause++;
      }

      if (verbose) {
        const status = `[${i + 1}/${files.length}] ${filePath}`;
        const cols = process.stdout.columns || 80;
        const truncated = status.length > cols - 1 ? status.slice(0, cols - 4) + '...' : status;
        process.stdout.write(`\r${truncated.padEnd(cols - 1)}`);
      }
    } catch (err: any) {
      result.filesErrored++;
      result.errors.push({ file: filePath, error: err.message });
    }

    // Report progress after each file
    if (onProgress) {
      result.durationMs = Date.now() - startTime;
      onProgress({ ...result, totalFiles: files.length });
    }

    // Yield the event loop between batches — only count files that actually embedded
    if (batchSize > 0 && embeddedSincePause >= batchSize && i + 1 < files.length) {
      await new Promise((r) => setTimeout(r, batchDelayMs));
      embeddedSincePause = 0;
    }
  }

  result.durationMs = Date.now() - startTime;

  if (verbose) {
    // Clear the progress line
    process.stdout.write(`\r${' '.repeat(process.stdout.columns || 80)}\r`);
  }

  // Log upload event
  try {
    await collection.storage.logUploadEvent({
      collectionId: collection.id,
      eventType: 'upload',
      sourcePath: absoluteDir,
      filesProcessed: result.filesProcessed,
      filesSkipped: result.filesSkipped,
      filesErrored: result.filesErrored,
      chunksCreated: result.chunksCreated,
      chunksDeleted: 0,
      durationMs: result.durationMs,
    });
  } catch {
    // non-fatal
  }

  return result;
}

async function ingestSingleFile(
  collection: Collection,
  absoluteFile: string,
  opts: Pick<IngestDirectoryOptions, 'verbose' | 'signal' | 'onProgress'>
): Promise<IngestResult> {
  const startTime = Date.now();
  const verbose = opts.verbose ?? false;
  const result: IngestResult = {
    filesProcessed: 0,
    filesSkipped: 0,
    filesErrored: 0,
    chunksCreated: 0,
    durationMs: 0,
    errors: [],
  };

  if (opts.signal?.aborted) {
    return result;
  }

  if (isBinaryExtension(absoluteFile)) {
    result.filesSkipped = 1;
    result.durationMs = Date.now() - startTime;
    opts.onProgress?.({ ...result, totalFiles: 1 });
    return result;
  }

  const git = detectGit(path.dirname(absoluteFile));
  const fileLabel = git ? path.relative(git.rootPath, absoluteFile) : absoluteFile;

  try {
    const ingestOpts: IngestOptions = {};
    if (git) {
      ingestOpts.repoName = git.name;
      ingestOpts.repoRootPath = git.rootPath;
      ingestOpts.remoteUrl = git.remoteUrl;
      ingestOpts.branch = git.branch;
      ingestOpts.commitHash = git.commitHash;
    }

    const chunks = await collection.ingest(absoluteFile, ingestOpts);
    if (chunks === 0) {
      result.filesSkipped = 1;
    } else {
      result.filesProcessed = 1;
      result.chunksCreated = chunks;
    }

    if (verbose) {
      console.log(`[1/1] ${fileLabel}`);
    }
  } catch (err: any) {
    result.filesErrored = 1;
    result.errors.push({ file: fileLabel, error: err.message });
  }

  result.durationMs = Date.now() - startTime;
  opts.onProgress?.({ ...result, totalFiles: 1 });

  try {
    await collection.storage.logUploadEvent({
      collectionId: collection.id,
      eventType: 'upload',
      sourcePath: absoluteFile,
      filesProcessed: result.filesProcessed,
      filesSkipped: result.filesSkipped,
      filesErrored: result.filesErrored,
      chunksCreated: result.chunksCreated,
      chunksDeleted: 0,
      durationMs: result.durationMs,
    });
  } catch {
    // non-fatal
  }

  return result;
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
// Git helpers
// ---------------------------------------------------------------------------

interface GitInfo {
  name: string;
  rootPath: string;
  branch: string;
  commitHash: string;
  remoteUrl: string | undefined;
}

function detectGit(dirPath: string): GitInfo | null {
  try {
    // Check if inside a git repo
    const topLevel = execSync('git rev-parse --show-toplevel', {
      cwd: dirPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const name = path.basename(topLevel);

    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: dirPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const commitHash = execSync('git rev-parse HEAD', {
      cwd: dirPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    let remoteUrl: string | undefined;
    try {
      remoteUrl = execSync('git remote get-url origin', {
        cwd: dirPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // no remote
    }

    return { name, rootPath: topLevel, branch, commitHash, remoteUrl };
  } catch {
    return null;
  }
}

function gitListFiles(dirPath: string): string[] {
  const output = execSync('git ls-files', {
    cwd: dirPath,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });

  return output
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && !isBinaryExtension(f));
}

// ---------------------------------------------------------------------------
// Filesystem walker
// ---------------------------------------------------------------------------

function walkDirectory(dirPath: string): string[] {
  const files: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(full);
        }
      } else if (entry.isFile() && !isBinaryExtension(entry.name)) {
        files.push(full);
      }
    }
  }

  walk(dirPath);
  return files;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  'venv', '.venv', '.tox', 'coverage', '.nyc_output', 'vendor', 'tmp',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.avif',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.sqlite', '.db', '.lock',
  '.log',
]);

function isBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// ---------------------------------------------------------------------------
// Commit history ingestion
// ---------------------------------------------------------------------------

export interface IngestCommitsOptions {
  /** Max commits to process (0 = no limit) */
  limit?: number;
  /** Only commits after this date (git --since format, e.g., '2025-01-01') */
  since?: string;
  /** Only commits before this date (git --until format) */
  until?: string;
  /** Specific branch (default: --all) */
  branch?: string;
  /** Log progress to console */
  verbose?: boolean;
  /** Called after each commit batch with current stats */
  onProgress?: (stats: IngestResult & { totalCommits: number }) => void;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Commits to process before yielding the event loop (default: 50) */
  batchSize?: number;
  /** Milliseconds to wait between batches (default: 200) */
  batchDelayMs?: number;
}

interface GitCommitRaw {
  sha: string;
  subject: string;
  body: string;
  author: string;
  date: string;
}

/**
 * Extract commit history from a git repo.
 * Returns parsed commit records.
 */
function gitListCommits(
  dirPath: string,
  opts?: { limit?: number; since?: string; until?: string; branch?: string }
): GitCommitRaw[] {
  // %H=sha, %s=subject, %b=body, %an=author, %aI=date
  // Use null bytes as field separators and record separator
  const args = ['log', '--format=%H%x00%s%x00%b%x00%an%x00%aI%x1e'];

  if (opts?.limit && opts.limit > 0) {
    args.push(`-n${opts.limit}`);
  }
  if (opts?.since) {
    args.push(`--since=${opts.since}`);
  }
  if (opts?.until) {
    args.push(`--until=${opts.until}`);
  }
  if (opts?.branch) {
    args.push(opts.branch);
  } else {
    args.push('--all');
  }

  const output = execSync('git ' + args.join(' '), {
    cwd: dirPath,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024, // 50MB for large histories
  });

  if (!output.trim()) return [];

  return output
    .split('\x1e')
    .filter((r) => r.trim())
    .map((record) => {
      const [sha, subject, body, author, date] = record.split('\x00');
      return {
        sha: sha.trim(),
        subject: subject?.trim() || '',
        body: body?.trim() || '',
        author: author?.trim() || '',
        date: date?.trim() || '',
      };
    });
}

/**
 * Build embedding-friendly text from a commit record.
 */
function formatCommitForEmbedding(commit: GitCommitRaw, repoName: string): string {
  const lines = [
    `commit ${commit.sha.slice(0, 12)}`,
    `Author: ${commit.author}`,
    `Date: ${commit.date}`,
    `Repo: ${repoName}`,
    '',
    commit.subject,
  ];
  if (commit.body) {
    lines.push('', commit.body);
  }
  return lines.join('\n');
}

/**
 * Ingest git commit history into a collection.
 * Each commit becomes a document via Collection.ingestContent().
 * Content-hash dedup ensures re-runs skip already-indexed commits.
 */
export async function ingestCommits(
  collection: Collection,
  dirPath: string,
  opts?: IngestCommitsOptions
): Promise<IngestResult> {
  const startTime = Date.now();
  const absoluteDir = path.resolve(dirPath);
  const verbose = opts?.verbose ?? false;
  const signal = opts?.signal;
  const batchSize = opts?.batchSize ?? 50;
  const batchDelayMs = opts?.batchDelayMs ?? 200;

  // Detect git info
  const git = detectGit(absoluteDir);
  if (!git) {
    throw new Error(`Not a git repository: ${absoluteDir}`);
  }

  if (verbose) console.log(`Indexing commits for: ${git.name} (${git.branch})`);

  // Extract commits
  const commits = gitListCommits(absoluteDir, {
    limit: opts?.limit,
    since: opts?.since,
    until: opts?.until,
    branch: opts?.branch,
  });

  if (verbose) console.log(`Commits to process: ${commits.length}`);

  const result: IngestResult = {
    filesProcessed: 0,
    filesSkipped: 0,
    filesErrored: 0,
    chunksCreated: 0,
    durationMs: 0,
    errors: [],
  };

  let embeddedSincePause = 0;

  for (let i = 0; i < commits.length; i++) {
    if (signal?.aborted) break;

    const commit = commits[i];
    const documentId = `commits/${git.name}/${commit.sha}`;
    const content = formatCommitForEmbedding(commit, git.name);

    try {
      const chunks = await collection.ingestContent(documentId, content, {
        language: 'git-commit',
        metadata: {
          sha: commit.sha,
          short_sha: commit.sha.slice(0, 7),
          author: commit.author,
          date: commit.date,
          repo: git.name,
          subject: commit.subject,
        },
      });

      if (chunks === 0) {
        result.filesSkipped++;
      } else {
        result.filesProcessed++;
        result.chunksCreated += chunks;
        embeddedSincePause++;
      }

      if (verbose) {
        const status = `[${i + 1}/${commits.length}] ${commit.sha.slice(0, 7)} ${commit.subject.slice(0, 60)}`;
        const cols = process.stdout.columns || 80;
        const truncated = status.length > cols - 1 ? status.slice(0, cols - 4) + '...' : status;
        process.stdout.write(`\r${truncated.padEnd(cols - 1)}`);
      }
    } catch (err: any) {
      result.filesErrored++;
      result.errors.push({ file: documentId, error: err.message });
    }

    // Report progress
    if (opts?.onProgress) {
      result.durationMs = Date.now() - startTime;
      opts.onProgress({ ...result, totalCommits: commits.length } as IngestResult & { totalCommits: number });
    }

    // Yield between batches — only count commits that actually embedded
    if (batchSize > 0 && embeddedSincePause >= batchSize && i + 1 < commits.length) {
      await new Promise((r) => setTimeout(r, batchDelayMs));
      embeddedSincePause = 0;
    }
  }

  result.durationMs = Date.now() - startTime;

  if (verbose) {
    process.stdout.write(`\r${' '.repeat(process.stdout.columns || 80)}\r`);
  }

  // Log upload event
  try {
    await collection.storage.logUploadEvent({
      collectionId: collection.id,
      eventType: 'upload',
      sourcePath: absoluteDir,
      filesProcessed: result.filesProcessed,
      filesSkipped: result.filesSkipped,
      filesErrored: result.filesErrored,
      chunksCreated: result.chunksCreated,
      chunksDeleted: 0,
      durationMs: result.durationMs,
    });
  } catch {
    // non-fatal
  }

  return result;
}
