/**
 * Assistant memory file management
 *
 * Claude Code stores per-project auto-memory files in
 * ~/.claude/projects/<encoded-path>/memory/*.md
 *
 * This service provides:
 * - Auto-discovery: scans disk on list/read calls
 * - Snapshots: new content creates new snapshot (keeps 5 most recent)
 * - History: full content history preserved in assistant_memory_file_snapshots
 * - File watching: auto-sync when memory files change on disk
 */

import { readdir, readFile, stat, writeFile, unlink, access, mkdir } from 'node:fs/promises';
import { watch, FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { query, querySingle } from '../db/client';
import { logger } from '../lib/logger';

const log = logger.child({ component: 'memory-watcher' });
import {
  getSessionsBasePath,
  resolveProjectDir,
  validateProjectDir,
  decodeDirName,
  ValidationError,
} from './sessions';

// ── Types ────────────────────────────────────────────────────────────

export interface MemoryFileRecord {
  id: string;
  assistant_id: string;
  project_id: string | null;
  project_dir: string;
  filename: string;
  file_path: string | null;
  current_snapshot: number;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryFileSnapshotRecord {
  id: string;
  memory_file_id: string;
  snapshot_number: number;
  content: string;
  file_hash: string;
  size: number | null;
  created_at: Date;
}

export interface MemoryFileSummary {
  id: string;
  filename: string;
  file_path: string | null;
  current_snapshot: number;
  snapshot_count: number;
  has_file: boolean;
  is_main: boolean;
  size: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryFile {
  id: string;
  filename: string;
  file_path: string | null;
  content: string;
  current_snapshot: number;
  snapshot_count: number;
  has_file: boolean;
  is_main: boolean;
  size: number | null;
  project_id: string | null;
  project_name: string | null;
  project_dir: string;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryFileSnapshotSummary {
  snapshot_number: number;
  size: number | null;
  file_hash: string;
  created_at: Date;
}

export interface MemoryFileSnapshot {
  id: string;
  snapshot_number: number;
  content: string;
  size: number | null;
  file_hash: string;
  created_at: Date;
}

export interface MemoryProject {
  dir_name: string;
  decoded_path: string;
  file_count: number;
  total_size: number;
  last_modified: Date | null;
  matched_project: { id: string; name: string; handle: string } | null;
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_SNAPSHOTS = 5;

// ── Helpers ──────────────────────────────────────────────────────────

function computeHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

export function validateFilename(filename: string): void {
  if (!filename.endsWith('.md')) {
    throw new ValidationError('Filename must end with .md');
  }
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    throw new ValidationError('Invalid filename');
  }
}

async function getAssistantId(handle: string): Promise<string | null> {
  const result = await querySingle<{ id: string }>(
    'SELECT id FROM assistants WHERE handle = $1',
    [handle]
  );
  return result?.id ?? null;
}

/**
 * Resolve project_id from a project directory name by encoding project paths and matching.
 * This avoids the issue where decodeDirName incorrectly splits folder names with hyphens.
 */
async function resolveProjectIdFromDir(dirName: string): Promise<string | null> {
  const projects = await query<{ id: string; path: string }>('SELECT id, path FROM projects WHERE path IS NOT NULL');
  for (const p of projects) {
    // Expand ~ in project path
    const expandedPath = p.path.startsWith('~')
      ? join(homedir(), p.path.slice(1))
      : p.path;
    // Encode path the same way Claude Code does: replace / with -
    const encodedDir = expandedPath.replace(/\//g, '-');
    if (encodedDir === dirName) {
      return p.id;
    }
  }
  return null;
}

/**
 * Prune snapshots for a memory file, keeping only the N most recent.
 */
async function pruneSnapshots(memoryFileId: string, keepCount: number = MAX_SNAPSHOTS): Promise<void> {
  await query(
    `DELETE FROM assistant_memory_file_snapshots
     WHERE memory_file_id = $1
       AND snapshot_number NOT IN (
         SELECT snapshot_number FROM assistant_memory_file_snapshots
         WHERE memory_file_id = $1
         ORDER BY snapshot_number DESC
         LIMIT $2
       )`,
    [memoryFileId, keepCount]
  );
}

// ── Discovery ────────────────────────────────────────────────────────

/**
 * Discover and sync memory files from disk to database.
 * - New files → create record + snapshot 1
 * - Changed files (hash differs) → add new snapshot, prune to MAX_SNAPSHOTS
 * - Deleted files (in DB but not disk) → set file_path = NULL
 */
export async function discoverMemoryFiles(
  assistantHandle: string,
  projectDir: string,
  overrideBasePath?: string
): Promise<void> {
  const basePath = getSessionsBasePath(assistantHandle, overrideBasePath);
  if (!basePath) return;

  const assistantId = await getAssistantId(assistantHandle);
  if (!assistantId) return;

  const memoryDir = join(basePath, projectDir, 'memory');

  // Read .md files from memory dir
  let diskFiles: string[];
  try {
    diskFiles = await readdir(memoryDir);
  } catch {
    diskFiles = [];
  }

  const mdFiles = diskFiles.filter((f) => f.endsWith('.md'));

  // Get existing records from DB for this project dir
  const dbRecords = await query<MemoryFileRecord>(
    'SELECT * FROM assistant_memory_files WHERE assistant_id = $1 AND project_dir = $2',
    [assistantId, projectDir]
  );
  const recordsByFilename = new Map(dbRecords.map((r) => [r.filename, r]));

  for (const filename of mdFiles) {
    const filePath = join(memoryDir, filename);

    let content: string;
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      [content, stats] = await Promise.all([
        readFile(filePath, 'utf-8'),
        stat(filePath),
      ]);
    } catch {
      continue;
    }

    const fileHash = computeHash(content);
    const size = stats.size;

    const existing = recordsByFilename.get(filename);

    if (!existing) {
      // New file: create record + snapshot 1
      const projectId = await resolveProjectIdFromDir(projectDir);

      const [newRecord] = await query<{ id: string }>(
        `INSERT INTO assistant_memory_files (assistant_id, project_id, project_dir, filename, file_path, current_snapshot)
         VALUES ($1, $2, $3, $4, $5, 1)
         RETURNING id`,
        [assistantId, projectId, projectDir, filename, filePath]
      );

      await query(
        `INSERT INTO assistant_memory_file_snapshots (memory_file_id, snapshot_number, content, file_hash, size)
         VALUES ($1, 1, $2, $3, $4)
         ON CONFLICT (memory_file_id, snapshot_number) DO NOTHING`,
        [newRecord.id, content, fileHash, size]
      );
    } else {
      // Existing record: check if content changed
      const latestSnapshot = await querySingle<{ file_hash: string }>(
        `SELECT file_hash FROM assistant_memory_file_snapshots
         WHERE memory_file_id = $1 AND snapshot_number = $2`,
        [existing.id, existing.current_snapshot]
      );

      if (latestSnapshot && latestSnapshot.file_hash !== fileHash) {
        // Content changed: create new snapshot
        const newSnapshot = existing.current_snapshot + 1;

        await query(
          `INSERT INTO assistant_memory_file_snapshots (memory_file_id, snapshot_number, content, file_hash, size)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (memory_file_id, snapshot_number) DO NOTHING`,
          [existing.id, newSnapshot, content, fileHash, size]
        );

        await query(
          `UPDATE assistant_memory_files SET current_snapshot = $1, file_path = $2, updated_at = NOW()
           WHERE id = $3`,
          [newSnapshot, filePath, existing.id]
        );

        // Prune old snapshots
        await pruneSnapshots(existing.id);
      } else if (!existing.file_path) {
        // File reappeared (was deleted, now back)
        await query(
          `UPDATE assistant_memory_files SET file_path = $1, updated_at = NOW() WHERE id = $2`,
          [filePath, existing.id]
        );
      }

      recordsByFilename.delete(filename);
    }
  }

  // Mark deleted files (remaining in map with non-null file_path)
  for (const [, record] of recordsByFilename) {
    if (record.file_path !== null) {
      await query(
        `UPDATE assistant_memory_files SET file_path = NULL, updated_at = NOW() WHERE id = $1`,
        [record.id]
      );
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * List project directories that have memory files
 */
export async function listMemoryProjects(
  assistantHandle: string,
  overrideBasePath?: string
): Promise<{ projects: MemoryProject[] }> {
  const basePath = getSessionsBasePath(assistantHandle, overrideBasePath);
  if (!basePath) return { projects: [] };

  // Scan base path for project dirs containing memory/ subdirs
  let projectDirs: string[];
  try {
    projectDirs = await readdir(basePath);
  } catch {
    return { projects: [] };
  }

  const projects: MemoryProject[] = [];

  for (const dirName of projectDirs) {
    const memoryDir = join(basePath, dirName, 'memory');

    let files: string[];
    try {
      files = (await readdir(memoryDir)).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    if (files.length === 0) continue;

    // Run discovery for this project dir
    await discoverMemoryFiles(assistantHandle, dirName, overrideBasePath);

    // Compute stats from disk
    let totalSize = 0;
    let lastModified: Date | null = null;

    for (const file of files) {
      try {
        const s = await stat(join(memoryDir, file));
        totalSize += s.size;
        if (!lastModified || s.mtime > lastModified) {
          lastModified = s.mtime;
        }
      } catch {
        continue;
      }
    }

    // Try to match to a khef project
    const projectId = await resolveProjectIdFromDir(dirName);
    let matchedProject: MemoryProject['matched_project'] = null;
    if (projectId) {
      const proj = await querySingle<{ id: string; name: string; handle: string }>(
        'SELECT id, name, handle FROM projects WHERE id = $1',
        [projectId]
      );
      if (proj) matchedProject = proj;
    }

    projects.push({
      dir_name: dirName,
      decoded_path: decodeDirName(dirName),
      file_count: files.length,
      total_size: totalSize,
      last_modified: lastModified,
      matched_project: matchedProject,
    });
  }

  // Sort by last modified descending
  projects.sort((a, b) => {
    const aTime = a.last_modified?.getTime() ?? 0;
    const bTime = b.last_modified?.getTime() ?? 0;
    return bTime - aTime;
  });

  return { projects };
}

/**
 * List memory files in a project directory
 */
export async function listMemoryFiles(
  assistantHandle: string,
  projectDir: string,
  overrideBasePath?: string
): Promise<{ files: MemoryFileSummary[] }> {
  validateProjectDir(projectDir);

  const assistantId = await getAssistantId(assistantHandle);
  if (!assistantId) return { files: [] };

  // Run discovery to sync disk → DB
  await discoverMemoryFiles(assistantHandle, projectDir, overrideBasePath);

  const files = await query<MemoryFileSummary & { snapshot_count: string }>(
    `SELECT
       amf.id,
       amf.filename,
       amf.file_path,
       amf.current_snapshot,
       (SELECT COUNT(*) FROM assistant_memory_file_snapshots WHERE memory_file_id = amf.id) as snapshot_count,
       (amf.file_path IS NOT NULL) as has_file,
       (amf.filename = 'MEMORY.md') as is_main,
       s.size,
       amf.created_at,
       amf.updated_at
     FROM assistant_memory_files amf
     JOIN assistant_memory_file_snapshots s ON s.memory_file_id = amf.id AND s.snapshot_number = amf.current_snapshot
     WHERE amf.assistant_id = $1 AND amf.project_dir = $2
     ORDER BY (amf.filename = 'MEMORY.md') DESC, amf.filename ASC`,
    [assistantId, projectDir]
  );

  return {
    files: files.map((f) => ({
      ...f,
      snapshot_count: parseInt(f.snapshot_count as unknown as string, 10),
    })),
  };
}

/**
 * Get a specific memory file (current version content)
 */
export async function getMemoryFile(
  assistantHandle: string,
  projectDir: string,
  filename: string,
  overrideBasePath?: string
): Promise<MemoryFile | null> {
  validateProjectDir(projectDir);
  validateFilename(filename);

  const assistantId = await getAssistantId(assistantHandle);
  if (!assistantId) return null;

  // Run discovery to ensure latest
  await discoverMemoryFiles(assistantHandle, projectDir, overrideBasePath);

  const result = await querySingle<MemoryFile & { snapshot_count: string }>(
    `SELECT
       amf.id,
       amf.filename,
       amf.file_path,
       s.content,
       amf.current_snapshot,
       (SELECT COUNT(*) FROM assistant_memory_file_snapshots WHERE memory_file_id = amf.id) as snapshot_count,
       (amf.file_path IS NOT NULL) as has_file,
       (amf.filename = 'MEMORY.md') as is_main,
       s.size,
       amf.project_id,
       proj.name as project_name,
       amf.project_dir,
       amf.created_at,
       amf.updated_at
     FROM assistant_memory_files amf
     JOIN assistant_memory_file_snapshots s ON s.memory_file_id = amf.id AND s.snapshot_number = amf.current_snapshot
     LEFT JOIN projects proj ON proj.id = amf.project_id
     WHERE amf.assistant_id = $1 AND amf.project_dir = $2 AND amf.filename = $3`,
    [assistantId, projectDir, filename]
  );

  if (!result) return null;

  return {
    ...result,
    snapshot_count: parseInt(result.snapshot_count as unknown as string, 10),
  };
}

/**
 * List all snapshots of a memory file
 */
export async function getMemoryFileSnapshots(
  assistantHandle: string,
  projectDir: string,
  filename: string
): Promise<{ snapshots: MemoryFileSnapshotSummary[] } | null> {
  validateProjectDir(projectDir);
  validateFilename(filename);

  const assistantId = await getAssistantId(assistantHandle);
  if (!assistantId) return null;

  const record = await querySingle<{ id: string }>(
    'SELECT id FROM assistant_memory_files WHERE assistant_id = $1 AND project_dir = $2 AND filename = $3',
    [assistantId, projectDir, filename]
  );

  if (!record) return null;

  const snapshots = await query<MemoryFileSnapshotSummary>(
    `SELECT snapshot_number, size, file_hash, created_at
     FROM assistant_memory_file_snapshots
     WHERE memory_file_id = $1
     ORDER BY snapshot_number DESC`,
    [record.id]
  );

  return { snapshots };
}

/**
 * Get a specific snapshot of a memory file
 */
export async function getMemoryFileSnapshot(
  assistantHandle: string,
  projectDir: string,
  filename: string,
  snapshotNumber: number
): Promise<MemoryFileSnapshot | null> {
  validateProjectDir(projectDir);
  validateFilename(filename);

  const assistantId = await getAssistantId(assistantHandle);
  if (!assistantId) return null;

  const result = await querySingle<MemoryFileSnapshot>(
    `SELECT s.id, s.snapshot_number, s.content, s.size, s.file_hash, s.created_at
     FROM assistant_memory_file_snapshots s
     JOIN assistant_memory_files amf ON amf.id = s.memory_file_id
     WHERE amf.assistant_id = $1 AND amf.project_dir = $2 AND amf.filename = $3 AND s.snapshot_number = $4`,
    [assistantId, projectDir, filename, snapshotNumber]
  );

  return result;
}

/**
 * Manually create a snapshot of the current memory file content.
 * Creates a new snapshot even if content matches the latest (for checkpointing).
 */
export async function createMemoryFileSnapshot(
  assistantHandle: string,
  projectDir: string,
  filename: string,
  overrideBasePath?: string
): Promise<{ snapshot_number: number } | null> {
  validateProjectDir(projectDir);
  validateFilename(filename);

  const assistantId = await getAssistantId(assistantHandle);
  if (!assistantId) return null;

  // Get the memory file record
  const record = await querySingle<{ id: string; current_snapshot: number }>(
    'SELECT id, current_snapshot FROM assistant_memory_files WHERE assistant_id = $1 AND project_dir = $2 AND filename = $3',
    [assistantId, projectDir, filename]
  );
  if (!record) return null;

  // Get current content from latest snapshot
  const latest = await querySingle<{ content: string; file_hash: string }>(
    'SELECT content, file_hash FROM assistant_memory_file_snapshots WHERE memory_file_id = $1 AND snapshot_number = $2',
    [record.id, record.current_snapshot]
  );
  if (!latest) return null;

  // Create new snapshot
  const newSnapshotNumber = record.current_snapshot + 1;
  await query(
    `INSERT INTO assistant_memory_file_snapshots (memory_file_id, snapshot_number, content, file_hash, size)
     VALUES ($1, $2, $3, $4, $5)`,
    [record.id, newSnapshotNumber, latest.content, latest.file_hash, Buffer.byteLength(latest.content, 'utf-8')]
  );

  // Update current_snapshot
  await query(
    'UPDATE assistant_memory_files SET current_snapshot = $1, updated_at = NOW() WHERE id = $2',
    [newSnapshotNumber, record.id]
  );

  // Prune old snapshots
  await pruneSnapshots(record.id);

  return { snapshot_number: newSnapshotNumber };
}

/**
 * Restore a memory file to a previous snapshot.
 * Writes the snapshot content to disk, which triggers a new snapshot.
 */
export async function restoreMemoryFileSnapshot(
  assistantHandle: string,
  projectDir: string,
  filename: string,
  snapshotNumber: number,
  overrideBasePath?: string
): Promise<{ restored_snapshot: number; new_snapshot: number } | null> {
  validateProjectDir(projectDir);
  validateFilename(filename);

  const assistantId = await getAssistantId(assistantHandle);
  if (!assistantId) return null;

  // Get the memory file record
  const record = await querySingle<{ id: string; current_snapshot: number; file_path: string | null }>(
    'SELECT id, current_snapshot, file_path FROM assistant_memory_files WHERE assistant_id = $1 AND project_dir = $2 AND filename = $3',
    [assistantId, projectDir, filename]
  );
  if (!record) return null;

  // Get the snapshot content
  const snapshot = await querySingle<{ content: string }>(
    'SELECT content FROM assistant_memory_file_snapshots WHERE memory_file_id = $1 AND snapshot_number = $2',
    [record.id, snapshotNumber]
  );
  if (!snapshot) return null;

  // Write content to disk (this will trigger a new snapshot via discovery)
  const basePath = getSessionsBasePath(assistantHandle, overrideBasePath);
  if (!basePath) return null;

  const memoryDir = join(basePath, projectDir, 'memory');
  await mkdir(memoryDir, { recursive: true });

  const filePath = join(memoryDir, filename);
  await writeFile(filePath, snapshot.content, 'utf-8');

  // Run discovery to create new snapshot
  await discoverMemoryFiles(assistantHandle, projectDir, overrideBasePath);

  // Get the new current snapshot
  const updated = await querySingle<{ current_snapshot: number }>(
    'SELECT current_snapshot FROM assistant_memory_files WHERE id = $1',
    [record.id]
  );

  return {
    restored_snapshot: snapshotNumber,
    new_snapshot: updated?.current_snapshot || record.current_snapshot,
  };
}

/**
 * Write a memory file to disk. Discovery will create the new snapshot.
 */
export async function writeMemoryFile(
  assistantHandle: string,
  projectDir: string,
  filename: string,
  content: string,
  overrideBasePath?: string
): Promise<MemoryFile | null> {
  validateProjectDir(projectDir);
  validateFilename(filename);

  const basePath = getSessionsBasePath(assistantHandle, overrideBasePath);
  if (!basePath) return null;

  const memoryDir = join(basePath, projectDir, 'memory');

  // Ensure memory directory exists
  await mkdir(memoryDir, { recursive: true });

  const filePath = join(memoryDir, filename);
  await writeFile(filePath, content, 'utf-8');

  // Run discovery to create/update the snapshot
  await discoverMemoryFiles(assistantHandle, projectDir, overrideBasePath);

  // Return the updated file
  return getMemoryFile(assistantHandle, projectDir, filename, overrideBasePath);
}

/**
 * Delete a memory file from disk. Preserves DB record and versions (marks file_path = NULL).
 */
export async function deleteMemoryFile(
  assistantHandle: string,
  projectDir: string,
  filename: string,
  overrideBasePath?: string
): Promise<{ success: boolean; error?: string }> {
  validateProjectDir(projectDir);
  validateFilename(filename);

  const basePath = getSessionsBasePath(assistantHandle, overrideBasePath);
  if (!basePath) return { success: false, error: 'Assistant does not support memory files' };

  const assistantId = await getAssistantId(assistantHandle);
  if (!assistantId) return { success: false, error: 'Assistant not found' };

  // Check DB record exists
  const record = await querySingle<{ id: string; file_path: string | null }>(
    'SELECT id, file_path FROM assistant_memory_files WHERE assistant_id = $1 AND project_dir = $2 AND filename = $3',
    [assistantId, projectDir, filename]
  );

  if (!record) return { success: false, error: 'Memory file not found' };

  // Delete from disk if exists
  if (record.file_path) {
    const filePath = join(basePath, projectDir, 'memory', filename);
    try {
      await unlink(filePath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        return { success: false, error: `Failed to delete file: ${err.message}` };
      }
    }
  }

  // Mark as deleted in DB (preserve snapshots for history)
  await query(
    `UPDATE assistant_memory_files SET file_path = NULL, updated_at = NOW() WHERE id = $1`,
    [record.id]
  );

  return { success: true };
}

/**
 * Delete a specific snapshot. Cannot delete the only remaining snapshot.
 */
export async function deleteMemoryFileSnapshot(
  assistantHandle: string,
  projectDir: string,
  filename: string,
  snapshotNumber: number
): Promise<{ deleted: boolean; error?: string }> {
  validateProjectDir(projectDir);
  validateFilename(filename);

  const assistantId = await getAssistantId(assistantHandle);
  if (!assistantId) return { deleted: false, error: 'Assistant not found' };

  const record = await querySingle<{ id: string; snapshot_count: number }>(
    `SELECT amf.id, (SELECT COUNT(*) FROM assistant_memory_file_snapshots WHERE memory_file_id = amf.id) as snapshot_count
     FROM assistant_memory_files amf
     WHERE amf.assistant_id = $1 AND amf.project_dir = $2 AND amf.filename = $3`,
    [assistantId, projectDir, filename]
  );

  if (!record) return { deleted: false, error: 'Memory file not found' };

  if (record.snapshot_count <= 1) {
    return { deleted: false, error: 'Cannot delete the only remaining snapshot' };
  }

  const result = await query(
    `DELETE FROM assistant_memory_file_snapshots WHERE memory_file_id = $1 AND snapshot_number = $2`,
    [record.id, snapshotNumber]
  );

  if ((result as any).length === 0 && (result as any).rowCount === 0) {
    return { deleted: false, error: 'Snapshot not found' };
  }

  return { deleted: true };
}

// ── File Watcher ─────────────────────────────────────────────────────

const memoryWatchers: Map<string, FSWatcher[]> = new Map();
const watchedProjectDirs: Set<string> = new Set();
let memoryDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

/**
 * Add a watcher for a single project's memory directory.
 * Returns the watcher if successful, null otherwise.
 */
async function addMemoryDirWatcher(
  handle: string,
  basePath: string,
  dirName: string
): Promise<FSWatcher | null> {
  if (watchedProjectDirs.has(dirName)) return null;

  const memoryDir = join(basePath, dirName, 'memory');
  try {
    await access(memoryDir);
    const watcher = watch(memoryDir, { persistent: true }, (event, filename) => {
      if (filename?.endsWith('.md')) {
        const timerKey = `${dirName}/${filename}`;
        const existing = memoryDebounceTimers.get(timerKey);
        if (existing) clearTimeout(existing);

        memoryDebounceTimers.set(timerKey, setTimeout(async () => {
          memoryDebounceTimers.delete(timerKey);
          log.info({ dir: dirName, file: filename }, 'Change detected, syncing');
          try {
            await discoverMemoryFiles(handle, dirName);
          } catch (err) {
            log.warn({ err, dir: dirName }, 'Discovery error');
          }
        }, 500));
      }
    });
    watchedProjectDirs.add(dirName);
    return watcher;
  } catch {
    // No memory dir for this project — skip
    return null;
  }
}

/**
 * Start watching all project memory directories for changes.
 * Also watches the base path for new project directories.
 */
export async function startMemoryFileWatcher(): Promise<void> {
  const handle = 'claude-code';
  const basePath = getSessionsBasePath(handle);
  if (!basePath) return;

  // Check if already watching
  if (memoryWatchers.has(handle)) return;

  try {
    await access(basePath);
  } catch {
    log.info({ basePath }, 'Base path not found');
    return;
  }

  const watcherList: FSWatcher[] = [];

  // Watch existing project memory directories
  try {
    const projectDirs = await readdir(basePath);
    for (const dirName of projectDirs) {
      const watcher = await addMemoryDirWatcher(handle, basePath, dirName);
      if (watcher) watcherList.push(watcher);
    }
  } catch (err) {
    log.warn({ err }, 'Failed to scan base path');
  }

  // Watch the base path for new project directories
  try {
    const baseWatcher = watch(basePath, { persistent: true }, (event, filename) => {
      if (!filename) return;

      // Debounce: new project dirs often have multiple events
      const timerKey = `base/${filename}`;
      const existing = memoryDebounceTimers.get(timerKey);
      if (existing) clearTimeout(existing);

      memoryDebounceTimers.set(timerKey, setTimeout(async () => {
        memoryDebounceTimers.delete(timerKey);
        // Check if this is a new project dir with a memory subdir
        const watcher = await addMemoryDirWatcher(handle, basePath, filename);
        if (watcher) {
          const list = memoryWatchers.get(handle);
          if (list) list.push(watcher);
          log.info({ project: filename }, 'Now watching new project');
        }
      }, 1000));
    });
    watcherList.push(baseWatcher);
  } catch (err) {
    log.warn({ err }, 'Failed to watch base path');
  }

  memoryWatchers.set(handle, watcherList);
  log.info({ count: watchedProjectDirs.size }, 'Watching memory directories (+ base path)');
}

/**
 * Stop all memory file watchers.
 */
export function stopMemoryFileWatcher(): void {
  for (const [handle, watcherList] of memoryWatchers) {
    for (const watcher of watcherList) {
      watcher.close();
    }
    log.info({ handle, watcherCount: watcherList.length }, 'Stopped watching');
  }
  memoryWatchers.clear();
  watchedProjectDirs.clear();

  for (const timer of memoryDebounceTimers.values()) {
    clearTimeout(timer);
  }
  memoryDebounceTimers.clear();
}
