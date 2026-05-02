/**
 * Git operations service.
 * Provides read-only git operations for commit history and diff generation.
 */
import { spawn } from 'child_process';

export interface GitCommit {
  sha: string;
  short_sha: string;
  message: string;
  body: string | null;
  author: string;
  date: string;
  stats?: DiffStats;
}

export interface DiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

export interface DiffResult {
  diff: string;
  stats: DiffStats;
  refs: {
    branch: string;
    commit_sha: string | null;
    parent_sha: string | null;
  };
  /** True when the commit has no parent (initial commit). The `diff` field
   *  contains only file headers, no line content, to avoid sending the
   *  entire repo as a unified diff. */
  is_initial_commit?: boolean;
}

export interface WorkingDiffResult {
  staged: { diff: string; stats: DiffStats };
  unstaged: { diff: string; stats: DiffStats };
  untracked: { diff: string; stats: DiffStats; files: string[]; skipped?: number };
  combined: { diff: string; stats: DiffStats };
  refs: {
    branch: string;
    commit_sha: null;
    parent_sha: string;
  };
}

/**
 * Sanitize git ref to prevent command injection.
 * Only allows alphanumeric, /, ., ^, ~, -, _
 */
export function sanitizeRef(ref: string): string {
  if (!/^[a-zA-Z0-9\/.\^~\-_]+$/.test(ref)) {
    throw new Error(`Invalid git ref: ${ref}`);
  }
  return ref;
}

/**
 * Execute a git command and return stdout.
 */
async function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`git ${args[0]} failed: ${stderr || 'unknown error'}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn git: ${err.message}`));
    });
  });
}

/**
 * Get current branch name.
 */
export async function getCurrentBranch(projectPath: string): Promise<string> {
  const result = await execGit(projectPath, ['branch', '--show-current']);
  const branch = result.trim();
  // Detached HEAD returns empty string
  if (!branch) {
    const head = await execGit(projectPath, ['rev-parse', '--short', 'HEAD']);
    return `detached:${head.trim()}`;
  }
  return branch;
}

/**
 * Get commit history.
 */
export async function getCommits(
  projectPath: string,
  options?: {
    branch?: string;
    limit?: number;
    offset?: number;
    path?: string;
  }
): Promise<GitCommit[]> {
  const limit = options?.limit ?? 20;
  const offset = options?.offset ?? 0;
  // Record separator is %x1e at the START of each commit format so trailing
  // --shortstat lines for commit N become part of record N (after the date).
  // %H=sha, %s=subject, %b=body, %an=author, %aI=date
  const args = [
    'log',
    '--shortstat',
    '--format=%x1e%H%x00%s%x00%b%x00%an%x00%aI',
    `-n${limit}`,
  ];

  if (offset > 0) {
    args.push(`--skip=${offset}`);
  }

  if (options?.branch) {
    args.push(sanitizeRef(options.branch));
  }

  if (options?.path) {
    args.push('--', options.path);
  }

  const output = await execGit(projectPath, args);
  if (!output.trim()) {
    return [];
  }

  // Split on record separator; first element is empty (leading %x1e)
  const records = output.split('\x1e').filter(r => r.trim());

  return records.map((record) => {
    const [sha, message, body, author, dateAndStats] = record.split('\x00');
    const trimmedBody = body?.trim() || null;
    // dateAndStats contains the ISO date on the first line and an optional
    // shortstat line (e.g., " 3 files changed, 10 insertions(+), 5 deletions(-)")
    // on a following line.
    const lines = (dateAndStats || '').split('\n').map(l => l.trim()).filter(Boolean);
    const date = lines[0] || '';
    const statLine = lines.find(l => /files? changed/.test(l));
    const stats = statLine ? parseStats(statLine) : undefined;
    return {
      sha: sha.trim(),
      short_sha: sha.trim().slice(0, 7),
      message: message?.trim() || '',
      body: trimmedBody,
      author: author?.trim() || '',
      date,
      ...(stats ? { stats } : {}),
    };
  });
}

/**
 * Parse diff stats from --stat output.
 */
function parseStats(statOutput: string): DiffStats {
  // Example: " 3 files changed, 10 insertions(+), 5 deletions(-)"
  const match = statOutput.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  if (!match) {
    return { files: 0, insertions: 0, deletions: 0 };
  }
  return {
    files: parseInt(match[1], 10) || 0,
    insertions: parseInt(match[2], 10) || 0,
    deletions: parseInt(match[3], 10) || 0,
  };
}

/**
 * Get diff for a specific commit.
 */
export async function getCommitDiff(
  projectPath: string,
  commitSha: string,
  path?: string
): Promise<DiffResult> {
  const safeSha = sanitizeRef(commitSha);
  const branch = await getCurrentBranch(projectPath);

  // Get parent SHA
  let parentSha: string | null = null;
  try {
    const parent = await execGit(projectPath, ['rev-parse', `${safeSha}^`]);
    parentSha = parent.trim();
  } catch {
    // Initial commit has no parent
    parentSha = null;
  }

  // Initial commit fast path: a real `git show` would emit the entire repo
  // as a unified diff (potentially many MB), which locks up the browser
  // parser. Synthesize a content-less header-only diff via `git diff-tree`
  // so the UI can list the added files without rendering line content.
  if (parentSha === null) {
    const treeArgs = ['diff-tree', '--no-commit-id', '--name-only', '--root', '-r', safeSha];
    if (path) {
      treeArgs.push('--', path);
    }
    const treeOutput = await execGit(projectPath, treeArgs);
    const files = treeOutput.split('\n').map((p) => p.trim()).filter(Boolean);
    const headerDiff = files
      .map((p) => `diff --git a/${p} b/${p}\nnew file mode 100644`)
      .join('\n');
    return {
      diff: headerDiff,
      stats: { files: files.length, insertions: 0, deletions: 0 },
      refs: {
        branch,
        commit_sha: safeSha,
        parent_sha: null,
      },
      is_initial_commit: true,
    };
  }

  // Get diff content
  const diffArgs = ['show', '--format=', safeSha];
  if (path) {
    diffArgs.push('--', path);
  }
  const diff = await execGit(projectPath, diffArgs);

  // Get stats
  const statArgs = ['show', '--stat', '--format=', safeSha];
  if (path) {
    statArgs.push('--', path);
  }
  const statOutput = await execGit(projectPath, statArgs);
  const stats = parseStats(statOutput);

  return {
    diff: diff.trimEnd(),
    stats,
    refs: {
      branch,
      commit_sha: safeSha,
      parent_sha: parentSha,
    },
  };
}

// Directories to exclude from untracked files (even if not in .gitignore)
const EXCLUDED_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '__pycache__',
  '.pytest_cache',
  'vendor',
  'target',
];

// Max file size to include in untracked diff (100KB)
const MAX_UNTRACKED_FILE_SIZE = 100 * 1024;

// Max total untracked files to process
const MAX_UNTRACKED_FILES = 50;

/**
 * Get untracked files and generate diff-like output for them.
 * Excludes large files, binary files, and common build/dependency directories.
 */
async function getUntrackedFiles(
  projectPath: string,
  filterPath?: string
): Promise<{ diff: string; stats: DiffStats; files: string[]; skipped?: number }> {
  const { stat } = await import('fs/promises');
  const { join } = await import('path');

  // Get list of untracked files (excluding ignored)
  const lsFilesArgs = ['ls-files', '--others', '--exclude-standard'];
  if (filterPath) {
    lsFilesArgs.push('--', filterPath);
  }
  const output = await execGit(projectPath, lsFilesArgs);
  let files = output.trim().split('\n').filter(Boolean);

  if (files.length === 0) {
    return { diff: '', stats: { files: 0, insertions: 0, deletions: 0 }, files: [] };
  }

  // Filter out excluded directories
  files = files.filter(file => {
    const parts = file.split('/');
    return !parts.some(part => EXCLUDED_DIRS.includes(part));
  });

  // Track how many files we skip
  let skipped = 0;
  const totalFiles = files.length;

  // Limit number of files
  if (files.length > MAX_UNTRACKED_FILES) {
    skipped += files.length - MAX_UNTRACKED_FILES;
    files = files.slice(0, MAX_UNTRACKED_FILES);
  }

  // Generate diff-like output for each untracked file
  const diffs: string[] = [];
  const includedFiles: string[] = [];
  let totalInsertions = 0;

  for (const file of files) {
    try {
      const filePath = join(projectPath, file);
      const fileStat = await stat(filePath);

      // Skip large files
      if (fileStat.size > MAX_UNTRACKED_FILE_SIZE) {
        skipped++;
        continue;
      }

      // Read file content
      const { readFile } = await import('fs/promises');
      const content = await readFile(filePath, 'utf-8');

      // Skip binary files (contains null bytes)
      if (content.includes('\0')) {
        skipped++;
        continue;
      }

      const lines = content.split('\n');
      // Don't count empty trailing line
      const lineCount = content.endsWith('\n') ? lines.length - 1 : lines.length;
      totalInsertions += lineCount;

      // Generate unified diff format for new file
      const diffHeader = [
        `diff --git a/${file} b/${file}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${file}`,
        `@@ -0,0 +1,${lineCount} @@`,
      ].join('\n');

      const diffContent = lines
        .slice(0, content.endsWith('\n') ? -1 : undefined)
        .map(line => `+${line}`)
        .join('\n');

      diffs.push(diffHeader + '\n' + diffContent);
      includedFiles.push(file);
    } catch {
      // Skip files that can't be read (binary, permission issues, etc.)
      skipped++;
    }
  }

  return {
    diff: diffs.join('\n'),
    stats: { files: includedFiles.length, insertions: totalInsertions, deletions: 0 },
    files: includedFiles,
    ...(skipped > 0 ? { skipped } : {}),
  };
}

/**
 * Get working tree diff (uncommitted changes).
 * Returns staged, unstaged, untracked, and combined diffs separately.
 */
export async function getWorkingDiff(
  projectPath: string,
  path?: string
): Promise<WorkingDiffResult> {
  const branch = await getCurrentBranch(projectPath);
  const head = await execGit(projectPath, ['rev-parse', 'HEAD']);

  // Staged changes (HEAD vs index)
  const stagedDiffArgs = ['diff', '--cached'];
  const stagedStatArgs = ['diff', '--cached', '--stat'];
  if (path) {
    stagedDiffArgs.push('--', path);
    stagedStatArgs.push('--', path);
  }
  const stagedDiff = await execGit(projectPath, stagedDiffArgs);
  const stagedStatOutput = await execGit(projectPath, stagedStatArgs);

  // Unstaged changes (index vs working tree)
  const unstagedDiffArgs = ['diff'];
  const unstagedStatArgs = ['diff', '--stat'];
  if (path) {
    unstagedDiffArgs.push('--', path);
    unstagedStatArgs.push('--', path);
  }
  const unstagedDiff = await execGit(projectPath, unstagedDiffArgs);
  const unstagedStatOutput = await execGit(projectPath, unstagedStatArgs);

  // Combined (HEAD vs working tree) - tracked files only
  const combinedDiffArgs = ['diff', 'HEAD'];
  const combinedStatArgs = ['diff', 'HEAD', '--stat'];
  if (path) {
    combinedDiffArgs.push('--', path);
    combinedStatArgs.push('--', path);
  }
  const combinedDiff = await execGit(projectPath, combinedDiffArgs);
  const combinedStatOutput = await execGit(projectPath, combinedStatArgs);
  const combinedStats = parseStats(combinedStatOutput);

  // Untracked files (new files not yet added to git)
  const untrackedResult = await getUntrackedFiles(projectPath, path);

  // Merge untracked into combined stats
  const totalStats: DiffStats = {
    files: combinedStats.files + untrackedResult.stats.files,
    insertions: combinedStats.insertions + untrackedResult.stats.insertions,
    deletions: combinedStats.deletions,
  };

  // Merge untracked diff into combined diff
  const fullCombinedDiff = untrackedResult.diff
    ? combinedDiff.trimEnd() + (combinedDiff.trim() ? '\n' : '') + untrackedResult.diff
    : combinedDiff.trimEnd();

  return {
    staged: {
      diff: stagedDiff.trimEnd(),
      stats: parseStats(stagedStatOutput),
    },
    unstaged: {
      diff: unstagedDiff.trimEnd(),
      stats: parseStats(unstagedStatOutput),
    },
    untracked: untrackedResult,
    combined: {
      diff: fullCombinedDiff,
      stats: totalStats,
    },
    refs: {
      branch,
      commit_sha: null,
      parent_sha: head.trim(),
    },
  };
}

// Max diff output size (1MB) — prevents browser from choking on massive diffs
const MAX_DIFF_BYTES = 1_000_000;

/**
 * Find the last complete file boundary before the byte limit.
 * Avoids truncating mid-file which would produce broken diff output.
 */
function findFileBoundary(diff: string, maxBytes: number): number {
  // Search backwards from the limit for "diff --git" at start of line
  const search = diff.slice(0, maxBytes);
  let pos = search.lastIndexOf('\ndiff --git ');
  if (pos > 0) return pos;
  // Fallback: just truncate at the limit
  return maxBytes;
}

export interface BranchDiffResult {
  diff: string;
  stats: DiffStats;
  refs: {
    branch: string;
    base: string;
    merge_base: string;
    commit_sha: string;
  };
  commits: GitCommit[];
  truncated?: {
    reason: 'size' | 'files';
    limit: number;
    total: number;
  };
}

/**
 * Get diff between current branch and a base branch.
 * Uses three-dot diff (merge-base) for PR-style comparison.
 */
export async function getBranchDiff(
  projectPath: string,
  base: string,
  path?: string
): Promise<BranchDiffResult> {
  const safeBase = sanitizeRef(base);
  const branch = await getCurrentBranch(projectPath);
  const head = await execGit(projectPath, ['rev-parse', 'HEAD']);

  // Find the merge base (may not exist for unrelated branches)
  let mergeBase: string;
  try {
    mergeBase = (await execGit(projectPath, ['merge-base', safeBase, 'HEAD'])).trim();
  } catch {
    // No common ancestor — fall back to two-dot diff
    mergeBase = safeBase;
  }

  // Get stats first (lightweight) to check scope
  const statArgs = ['diff', `${mergeBase}..HEAD`, '--stat'];
  if (path) {
    statArgs.push('--', path);
  }
  const statOutput = await execGit(projectPath, statArgs);
  const stats = parseStats(statOutput);

  // Diff from merge base to HEAD, with size limit
  const diffArgs = ['diff', `${mergeBase}..HEAD`];
  if (path) {
    diffArgs.push('--', path);
  }
  const rawDiff = await execGit(projectPath, diffArgs);

  let diff = rawDiff.trimEnd();
  let truncated: BranchDiffResult['truncated'] | undefined;

  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) {
    // Truncate at a file boundary to avoid partial diffs
    const cutPoint = findFileBoundary(diff, MAX_DIFF_BYTES);
    const truncatedDiff = diff.slice(0, cutPoint);
    const filesInTruncated = (truncatedDiff.match(/^diff --git /gm) || []).length;

    truncated = {
      reason: 'size',
      limit: filesInTruncated,
      total: stats.files,
    };
    diff = truncatedDiff;
  }

  // Commits in the range (base..HEAD), capped at 200
  const commits = await getCommits(projectPath, { branch: `${safeBase}..HEAD`, limit: 200 });

  return {
    diff,
    stats,
    refs: {
      branch,
      base: safeBase,
      merge_base: mergeBase,
      commit_sha: head.trim(),
    },
    commits,
    ...(truncated ? { truncated } : {}),
  };
}

/**
 * List local branches.
 */
export async function getBranches(projectPath: string): Promise<string[]> {
  const output = await execGit(projectPath, ['branch', '--format=%(refname:short)']);
  return output.trim().split('\n').filter(Boolean);
}

/**
 * Get the default branch (main or master).
 */
export async function getDefaultBranch(projectPath: string): Promise<string | null> {
  const branches = await getBranches(projectPath);
  if (branches.includes('main')) return 'main';
  if (branches.includes('master')) return 'master';
  return branches[0] || null;
}

/**
 * Check if the working tree has uncommitted changes (staged or unstaged).
 */
export async function hasUncommittedChanges(projectPath: string): Promise<boolean> {
  const output = await execGit(projectPath, ['status', '--porcelain']);
  return output.trim().length > 0;
}

/**
 * Checkout a branch. Returns the new current branch name.
 * Throws if the working tree is dirty or the branch doesn't exist.
 */
export async function checkoutBranch(
  projectPath: string,
  branch: string
): Promise<string> {
  const safeBranch = sanitizeRef(branch);

  // Verify branch exists
  const branches = await getBranches(projectPath);
  if (!branches.includes(safeBranch)) {
    throw new Error(`Branch not found: ${safeBranch}`);
  }

  // Check for uncommitted changes
  if (await hasUncommittedChanges(projectPath)) {
    throw new Error('Cannot switch branches: you have uncommitted changes. Commit or stash them first.');
  }

  await execGit(projectPath, ['checkout', safeBranch]);
  return getCurrentBranch(projectPath);
}

/**
 * Check if a path is a git repository.
 */
export async function isGitRepo(projectPath: string): Promise<boolean> {
  try {
    await execGit(projectPath, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}
