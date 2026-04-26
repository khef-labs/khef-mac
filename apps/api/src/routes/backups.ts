import { FastifyPluginAsync } from 'fastify';
import { query, querySingle } from '../db/client';
import { readdir, stat, unlink, access } from 'fs/promises';
import { existsSync, statSync, readdirSync } from 'fs';
import * as os from 'os';
import { join, resolve, isAbsolute, sep as pathSep } from 'path';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const BACKUP_FILENAME_PATTERN = /^khef_\d{8}_\d{6}\.sql(\.gz)?$/;

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${parseFloat(value.toFixed(1))} ${units[i]}`;
}

function expandTilde(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return filepath.replace('~', os.homedir());
  }
  return filepath;
}

async function getBackupDir(): Promise<string> {
  const row = await querySingle<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'backup.location'"
  );
  const location = row?.value || 'db/backups';
  if (isAbsolute(location)) return location;
  // Relative to CWD (apps/api/ when run via npm scripts)
  return resolve(process.cwd(), location);
}

interface ArchiveFileEntry {
  full_path: string;
  filename: string;
  relative_path: string;
  assistant_handle: string;
  size: number;
  mtime_ms: number;
}

/**
 * Walk the archive root recursively, capturing every .jsonl entry.
 * Returns zero counts and an empty entries array if the directory does not exist.
 */
function walkArchiveRoot(rootDir: string): {
  totalFiles: number;
  totalBytes: number;
  entries: ArchiveFileEntry[];
} {
  let totalFiles = 0;
  let totalBytes = 0;
  const entries: ArchiveFileEntry[] = [];

  function walk(dir: string): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        walk(full);
      } else if (info.isFile() && name.endsWith('.jsonl')) {
        totalFiles += 1;
        totalBytes += info.size;
        const rel = full.startsWith(rootDir + '/') ? full.slice(rootDir.length + 1) : full;
        const assistantHandle = rel.includes('/') ? rel.split('/')[0] : '';
        entries.push({
          full_path: full,
          filename: name,
          relative_path: rel,
          assistant_handle: assistantHandle,
          size: info.size,
          mtime_ms: info.mtimeMs,
        });
      }
    }
  }

  walk(rootDir);
  return { totalFiles, totalBytes, entries };
}

async function listDbBackups(dir: string) {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err: any) {
    if (err.code === 'ENOENT') return { backups: [], directory: dir };
    throw err;
  }

  const backupFiles = entries.filter((f) => BACKUP_FILENAME_PATTERN.test(f));
  const backups = await Promise.all(
    backupFiles.map(async (filename) => {
      const filepath = join(dir, filename);
      const info = await stat(filepath);
      return {
        filename,
        size: info.size,
        size_human: formatBytes(info.size),
        created_at: info.mtime.toISOString(),
        path: filepath,
      };
    })
  );
  backups.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { backups, directory: dir };
}

const backupRoutes: FastifyPluginAsync = async (fastify) => {
  // ==========================================================================
  // Database backups — /api/backups/db
  // ==========================================================================

  // GET /api/backups/db — List database backup files
  fastify.get('/db', async (_request, reply) => {
    const dir = await getBackupDir();
    try {
      return await listDbBackups(dir);
    } catch (err: any) {
      return reply.code(500).send({
        error: 'Cannot read backup directory',
        detail: err.message,
        directory: dir,
      });
    }
  });

  // POST /api/backups/db — Trigger a new backup
  fastify.post('/db', async (_request, reply) => {
    const dir = await getBackupDir();
    const scriptPath = resolve(process.cwd(), 'db/scripts/backup.sh');

    return new Promise((resolvePromise) => {
      execFile('bash', [scriptPath], { env: { ...process.env, BACKUP_DIR: dir }, cwd: process.cwd() }, async (err, stdout, stderr) => {
        // The script may exit non-zero due to rotation cleanup (e.g., no .sql files to glob)
        // but the backup itself can still succeed. Check stdout for confirmation.
        const backupCreated = stdout.includes('Backup saved');
        if (err && !backupCreated) {
          reply.code(500).send({
            error: 'Backup failed',
            detail: stderr || stdout || err.message,
          });
          return resolvePromise(undefined);
        }

        try {
          const { backups } = await listDbBackups(dir);
          const created = backups[0] || null;
          reply.code(201).send({
            backup: created,
            output: stdout.trim(),
          });
        } catch {
          reply.code(201).send({
            backup: null,
            output: stdout.trim(),
          });
        }
        resolvePromise(undefined);
      });
    });
  });

  // DELETE /api/backups/db/:filename — Delete a backup file
  fastify.delete<{ Params: { filename: string } }>(
    '/db/:filename',
    async (request, reply) => {
      const { filename } = request.params;

      if (!BACKUP_FILENAME_PATTERN.test(filename)) {
        return reply.code(400).send({ error: 'Invalid backup filename' });
      }

      const dir = await getBackupDir();
      const filepath = join(dir, filename);

      try {
        await unlink(filepath);
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return reply.code(404).send({ error: 'Backup file not found' });
        }
        return reply.code(500).send({
          error: 'Failed to delete backup',
          detail: err.message,
        });
      }

      return reply.code(204).send();
    }
  );

  // POST /api/backups/db/:filename/restore — Restore database from a backup file
  fastify.post<{ Params: { filename: string } }>(
    '/db/:filename/restore',
    async (request, reply) => {
      const { filename } = request.params;

      if (!BACKUP_FILENAME_PATTERN.test(filename)) {
        return reply.code(400).send({ error: 'Invalid backup filename' });
      }

      const dir = await getBackupDir();
      const filepath = join(dir, filename);

      try {
        await access(filepath);
      } catch {
        return reply.code(404).send({ error: 'Backup file not found' });
      }

      const container = process.env.POSTGRES_CONTAINER || 'khef';
      const dbName = process.env.POSTGRES_DB || 'khef';
      const dbUser = process.env.POSTGRES_USER || 'postgres';

      // Step 1: Create safety backup before restoring
      let safetyBackup: string | null = null;
      try {
        const scriptPath = resolve(process.cwd(), 'db/scripts/backup.sh');
        const { stdout } = await execFileAsync('bash', [scriptPath], {
          env: { ...process.env, BACKUP_DIR: dir },
          cwd: process.cwd(),
        });
        const match = stdout.match(/Backup saved.*?(khef_\d{8}_\d{6}\.sql(?:\.gz)?)/);
        if (match) safetyBackup = match[1];
      } catch (err: any) {
        request.log.warn({ err }, 'Safety backup before restore failed');
      }

      try {
        // Step 2: Terminate existing connections
        await execFileAsync('docker', [
          'exec', container, 'psql', '-U', dbUser, '-d', 'postgres', '-q',
          '-c', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
        ]);

        // Step 3: Drop and recreate database
        await execFileAsync('docker', [
          'exec', container, 'psql', '-U', dbUser, '-d', 'postgres',
          '-c', `DROP DATABASE IF EXISTS "${dbName}";`,
          '-c', `CREATE DATABASE "${dbName}";`,
        ]);

        // Step 4: Restore from backup
        if (filepath.endsWith('.gz')) {
          await execAsync(`gunzip -c "${filepath}" | docker exec -i "${container}" psql -U "${dbUser}" -d "${dbName}" -q`);
        } else {
          await execAsync(`docker exec -i "${container}" psql -U "${dbUser}" -d "${dbName}" -q < "${filepath}"`);
        }

        // Step 5: Run migrations
        const migrateScript = resolve(process.cwd(), 'db/migrate/scripts/migrate.ts');
        await execFileAsync('npx', ['tsx', migrateScript], {
          env: { ...process.env },
          cwd: process.cwd(),
        });

        return {
          success: true,
          restored_from: filename,
          safety_backup: safetyBackup,
          message: `Database restored from ${filename}. ${safetyBackup ? `Safety backup: ${safetyBackup}` : 'No safety backup was created.'}`,
        };
      } catch (err: any) {
        request.log.error({ err }, 'Restore failed');
        return reply.code(500).send({
          error: 'Restore failed',
          detail: err.stderr || err.message,
          safety_backup: safetyBackup,
        });
      }
    }
  );

  // ==========================================================================
  // Session file backups — /api/backups/sessions
  // ==========================================================================

  // GET /api/backups/sessions — List sessions whose original JSONL is gone but
  // an archived copy exists in the backup location.
  fastify.get('/sessions', async (_request, reply) => {
    const settingRows = await query<{ key: string; value: string }>(
      `SELECT key, value FROM settings WHERE key IN ('sessions.backupPath', 'sessions.backupEnabled')`
    );
    const settingMap: Record<string, string> = {};
    for (const row of settingRows) settingMap[row.key] = row.value;

    const enabled = settingMap['sessions.backupEnabled'] === 'true';
    const backupPath = (settingMap['sessions.backupPath'] ?? '').trim();

    if (!enabled || !backupPath) {
      return {
        sessions: [],
        largest_files: [],
        directory: backupPath || null,
        enabled,
        archive_total_files: 0,
        archive_total_bytes: 0,
        archive_total_size_human: '0 B',
      };
    }

    const archiveRoot = resolve(expandTilde(backupPath));
    const { totalFiles, totalBytes, entries: archiveEntries } = walkArchiveRoot(archiveRoot);

    const LARGEST_FILES_LIMIT = 10;
    const topEntries = [...archiveEntries]
      .sort((a, b) => b.size - a.size)
      .slice(0, LARGEST_FILES_LIMIT);

    // Look up DB rows by candidate session_id. Claude Code names files
    // <uuid>.jsonl directly; Codex CLI names them rollout-<ts>-<uuid>.jsonl.
    // Match the trailing UUID before .jsonl to handle both.
    const UUID_BEFORE_JSONL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
    const candidateByEntry = topEntries.map((e) => {
      const m = e.filename.match(UUID_BEFORE_JSONL);
      return m ? m[1] : e.filename.replace(/\.jsonl$/, '');
    });
    const candidateSessionIds = Array.from(new Set(candidateByEntry.filter(Boolean)));

    type SessionLookupRow = {
      id: string;
      session_id: string;
      nickname: string | null;
      project_handle: string | null;
      project_name: string | null;
    };
    let sessionLookup: Map<string, SessionLookupRow> = new Map();
    if (candidateSessionIds.length > 0) {
      const lookup = await query<SessionLookupRow>(
        `SELECT s.id, s.session_id, s.nickname,
                p.handle AS project_handle, p.name AS project_name
         FROM sessions s
         LEFT JOIN projects p ON p.id = s.project_id
         WHERE s.session_id = ANY($1::varchar[])`,
        [candidateSessionIds]
      );
      sessionLookup = new Map(lookup.map((r) => [r.session_id, r]));
    }

    const largestFiles = topEntries.map((entry, idx) => {
      const candidate = candidateByEntry[idx];
      const match = candidate ? sessionLookup.get(candidate) : undefined;
      return {
        filename: entry.filename,
        relative_path: entry.relative_path,
        archive_path: entry.full_path,
        assistant_handle: entry.assistant_handle,
        size: entry.size,
        size_human: formatBytes(entry.size),
        modified_at: new Date(entry.mtime_ms).toISOString(),
        session_db_id: match?.id ?? null,
        session_id: match?.session_id ?? null,
        nickname: match?.nickname ?? null,
        project_handle: match?.project_handle ?? null,
        project_name: match?.project_name ?? null,
      };
    });

    const rows = await query<{
      id: string;
      session_id: string;
      nickname: string | null;
      project_dir: string | null;
      file_path: string;
      file_size: string | null;
      updated_at: string | null;
      assistant_handle: string;
      project_handle: string | null;
      project_name: string | null;
    }>(
      `SELECT s.id, s.session_id, s.nickname, s.project_dir, s.file_path,
              s.file_size::text AS file_size, s.updated_at::text AS updated_at,
              a.handle AS assistant_handle,
              p.handle AS project_handle,
              p.name AS project_name
       FROM sessions s
       JOIN assistants a ON a.id = s.assistant_id
       LEFT JOIN projects p ON p.id = s.project_id
       ORDER BY s.updated_at DESC NULLS LAST`
    );

    const results: Array<{
      id: string;
      session_id: string;
      nickname: string | null;
      project_dir: string | null;
      project_handle: string | null;
      project_name: string | null;
      assistant_handle: string;
      archive_path: string;
      size: number;
      size_human: string;
      updated_at: string | null;
    }> = [];

    for (const row of rows) {
      // Skip sessions whose original file still exists
      if (row.file_path && existsSync(row.file_path)) continue;
      if (!row.project_dir) continue;

      const archivePath = join(
        archiveRoot,
        row.assistant_handle,
        row.project_dir,
        `${row.session_id}.jsonl`
      );
      if (!existsSync(archivePath)) continue;

      let size = 0;
      try {
        size = (await stat(archivePath)).size;
      } catch {
        continue;
      }

      results.push({
        id: row.id,
        session_id: row.session_id,
        nickname: row.nickname,
        project_dir: row.project_dir,
        project_handle: row.project_handle,
        project_name: row.project_name,
        assistant_handle: row.assistant_handle,
        archive_path: archivePath,
        size,
        size_human: formatBytes(size),
        updated_at: row.updated_at,
      });
    }

    return {
      sessions: results,
      largest_files: largestFiles,
      directory: archiveRoot,
      enabled,
      archive_total_files: totalFiles,
      archive_total_bytes: totalBytes,
      archive_total_size_human: formatBytes(totalBytes),
    };
  });

  // POST /api/backups/sessions/reveal — Reveal an archived file in Finder.
  // macOS-only. Path is validated to live under the configured archive root.
  fastify.post<{ Body: { path?: string } }>(
    '/sessions/reveal',
    async (request, reply) => {
      const requested = request.body?.path;
      if (typeof requested !== 'string' || requested.length === 0) {
        return reply.code(400).send({ error: 'path is required' });
      }

      const settingRows = await query<{ key: string; value: string }>(
        `SELECT key, value FROM settings WHERE key IN ('sessions.backupPath', 'sessions.backupEnabled')`
      );
      const map: Record<string, string> = {};
      for (const row of settingRows) map[row.key] = row.value;
      const enabled = map['sessions.backupEnabled'] === 'true';
      const backupPath = (map['sessions.backupPath'] ?? '').trim();
      if (!enabled || !backupPath) {
        return reply.code(409).send({ error: 'Session backup is disabled' });
      }

      const archiveRoot = resolve(expandTilde(backupPath));
      const target = resolve(requested);
      if (target !== archiveRoot && !target.startsWith(archiveRoot + pathSep)) {
        return reply.code(403).send({ error: 'Path is outside the archive root' });
      }

      if (!existsSync(target)) {
        return reply.code(404).send({ error: 'File not found on disk' });
      }

      if (process.platform !== 'darwin') {
        return reply.code(501).send({ error: 'Reveal in Finder is only supported on macOS' });
      }

      try {
        await execFileAsync('open', ['-R', target]);
      } catch (err: any) {
        return reply.code(500).send({
          error: 'Failed to reveal file',
          detail: err?.stderr || err?.message,
        });
      }

      return reply.code(204).send();
    }
  );
};

export default backupRoutes;
