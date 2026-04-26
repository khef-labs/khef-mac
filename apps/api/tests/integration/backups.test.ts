import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setupTestDb, TEST_DATABASE_URL } from '../setup';

process.env.DATABASE_URL = TEST_DATABASE_URL;

import backupRoutes from '../../src/routes/backups';

describe('Backup Routes', () => {
  let app: FastifyInstance;
  let client: Client;
  let tmpBackupDir: string;
  let tmpArchiveDir: string;
  let assistantId: string;

  beforeAll(async () => {
    await setupTestDb();

    app = Fastify();
    app.register(backupRoutes, { prefix: '/api/backups' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();

    tmpBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khef-db-backup-'));
    tmpArchiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khef-session-archive-'));

    // Point backup.location at our temp dir so list endpoint reads from it
    await client.query(
      `INSERT INTO settings (key, value, description, value_type) VALUES ('backup.location', $1, 'test', 'string')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [tmpBackupDir]
    );

    // Seed (or reuse) a claude-code assistant for session archive tests
    const res = await client.query(
      `INSERT INTO assistants (handle, name, description) VALUES ('claude-code', 'Claude Code', 'test')
       ON CONFLICT (handle) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    assistantId = res.rows[0].id;
  });

  afterAll(async () => {
    await client.end();
    await app.close();
    fs.rmSync(tmpBackupDir, { recursive: true, force: true });
    fs.rmSync(tmpArchiveDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Reset backup files between tests
    for (const f of fs.readdirSync(tmpBackupDir)) {
      fs.rmSync(path.join(tmpBackupDir, f), { recursive: true, force: true });
    }
    // Reset archive between tests
    for (const f of fs.readdirSync(tmpArchiveDir)) {
      fs.rmSync(path.join(tmpArchiveDir, f), { recursive: true, force: true });
    }
    // Reset sessions between tests
    await client.query('TRUNCATE sessions CASCADE');
    // Reset session backup settings between tests
    await client.query(
      `DELETE FROM settings WHERE key IN ('sessions.backupEnabled', 'sessions.backupPath')`
    );
  });

  describe('GET /api/backups/db', () => {
    it('returns an empty list when directory has no backup files', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/backups/db' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.backups).toEqual([]);
      expect(body.directory).toBe(tmpBackupDir);
    });

    it('returns matching backup files with sizes and timestamps, newest first', async () => {
      const olderPath = path.join(tmpBackupDir, 'khef_20260101_000000.sql');
      const newerPath = path.join(tmpBackupDir, 'khef_20260412_120000.sql.gz');
      fs.writeFileSync(olderPath, 'older');
      fs.writeFileSync(newerPath, 'newer-gz-content');

      // Force a distinct mtime so "newest first" sort is unambiguous.
      fs.utimesSync(olderPath, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
      fs.utimesSync(newerPath, new Date('2026-04-12T12:00:00Z'), new Date('2026-04-12T12:00:00Z'));

      const res = await app.inject({ method: 'GET', url: '/api/backups/db' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.backups).toHaveLength(2);
      expect(body.backups[0].filename).toBe('khef_20260412_120000.sql.gz');
      expect(body.backups[1].filename).toBe('khef_20260101_000000.sql');
      expect(body.backups[0].size).toBe('newer-gz-content'.length);
      expect(body.backups[0].size_human).toMatch(/B$/);
      expect(body.backups[0].path).toBe(newerPath);
    });

    it('ignores files that do not match the khef backup filename pattern', async () => {
      fs.writeFileSync(path.join(tmpBackupDir, 'random.sql'), 'x');
      fs.writeFileSync(path.join(tmpBackupDir, 'notes.txt'), 'x');
      fs.writeFileSync(path.join(tmpBackupDir, 'khef_20260412_120000.sql'), 'valid');

      const res = await app.inject({ method: 'GET', url: '/api/backups/db' });
      const body = JSON.parse(res.payload);
      expect(body.backups.map((b: any) => b.filename)).toEqual(['khef_20260412_120000.sql']);
    });
  });

  describe('DELETE /api/backups/db/:filename', () => {
    it('returns 400 when filename does not match backup pattern', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/backups/db/not-a-backup.sql',
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toBe('Invalid backup filename');
    });

    it('returns 404 when backup file is missing', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/backups/db/khef_20260412_120000.sql',
      });
      expect(res.statusCode).toBe(404);
    });

    it('removes an existing backup file and returns 204', async () => {
      const filename = 'khef_20260412_120000.sql';
      fs.writeFileSync(path.join(tmpBackupDir, filename), 'x');

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/backups/db/${filename}`,
      });
      expect(res.statusCode).toBe(204);
      expect(fs.existsSync(path.join(tmpBackupDir, filename))).toBe(false);
    });
  });

  describe('POST /api/backups/db/:filename/restore', () => {
    it('returns 400 when filename is invalid', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/backups/db/random.sql/restore',
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toBe('Invalid backup filename');
    });

    it('returns 404 when backup file does not exist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/backups/db/khef_20260412_120000.sql/restore',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/backups/sessions', () => {
    it('returns enabled=false and empty sessions when backup is disabled', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/backups/sessions' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.enabled).toBe(false);
      expect(body.sessions).toEqual([]);
      expect(body.archive_total_files).toBe(0);
      expect(body.archive_total_bytes).toBe(0);
      expect(body.archive_total_size_human).toBe('0 B');
    });

    it('returns empty sessions when enabled but backup path is empty', async () => {
      await client.query(
        `INSERT INTO settings (key, value, description, value_type) VALUES
         ('sessions.backupEnabled', 'true', 'test', 'boolean'),
         ('sessions.backupPath', '', 'test', 'string')`
      );

      const res = await app.inject({ method: 'GET', url: '/api/backups/sessions' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.enabled).toBe(true);
      expect(body.sessions).toEqual([]);
    });

    it('returns the 10 largest archived jsonl files sorted descending with session linkage', async () => {
      await client.query(
        `INSERT INTO settings (key, value, description, value_type) VALUES
         ('sessions.backupEnabled', 'true', 'test', 'boolean'),
         ('sessions.backupPath', $1, 'test', 'string')`,
        [tmpArchiveDir]
      );

      const projectDir = '-Users-test-largest';
      const claudeDir = path.join(tmpArchiveDir, 'claude-code', projectDir);
      const codexDir = path.join(tmpArchiveDir, 'codex-cli', '2026', '04', '12');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.mkdirSync(codexDir, { recursive: true });

      // 12 files of varying sizes — top 10 should be returned, smallest two trimmed.
      const claudeUuid = '11111111-2222-3333-4444-555555555555';
      const codexUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

      // Claude Code (filename = uuid + .jsonl) — large match
      fs.writeFileSync(path.join(claudeDir, `${claudeUuid}.jsonl`), 'a'.repeat(5000));
      // Codex CLI (filename = rollout-<ts>-<uuid>.jsonl) — UUID is trailing
      fs.writeFileSync(
        path.join(codexDir, `rollout-2026-04-12T10-00-00-${codexUuid}.jsonl`),
        'b'.repeat(8000)
      );
      // Filler smaller files
      for (let i = 0; i < 10; i++) {
        fs.writeFileSync(path.join(claudeDir, `filler-${i}.jsonl`), 'x'.repeat(100 + i));
      }

      // Seed DB rows so the claude-code file can be linked
      await client.query(
        `INSERT INTO sessions (session_id, assistant_id, project_dir, file_path, file_size, nickname)
         VALUES ($1, $2, $3, $4, 5000, 'biggie')`,
        [claudeUuid, assistantId, projectDir, path.join(claudeDir, `${claudeUuid}.jsonl`)]
      );

      const res = await app.inject({ method: 'GET', url: '/api/backups/sessions' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);

      expect(body.largest_files).toHaveLength(10);
      // Sorted descending — codex (8000) then claude (5000) then fillers
      expect(body.largest_files[0].size).toBe(8000);
      expect(body.largest_files[0].filename).toMatch(new RegExp(`${codexUuid}\\.jsonl$`));
      expect(body.largest_files[0].assistant_handle).toBe('codex-cli');
      // No DB row for the codex session, so no link
      expect(body.largest_files[0].session_db_id).toBeNull();

      expect(body.largest_files[1].size).toBe(5000);
      expect(body.largest_files[1].assistant_handle).toBe('claude-code');
      expect(body.largest_files[1].nickname).toBe('biggie');
      expect(body.largest_files[1].session_db_id).not.toBeNull();

      // Confirm strictly descending size
      const sizes = body.largest_files.map((f: any) => f.size);
      for (let i = 1; i < sizes.length; i++) {
        expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]);
      }
    });

    it('reports total file count and bytes for the entire archive root', async () => {
      await client.query(
        `INSERT INTO settings (key, value, description, value_type) VALUES
         ('sessions.backupEnabled', 'true', 'test', 'boolean'),
         ('sessions.backupPath', $1, 'test', 'string')`,
        [tmpArchiveDir]
      );

      // Drop a few files of known sizes spread across nested subdirs
      const subA = path.join(tmpArchiveDir, 'claude-code', '-Users-test-a');
      const subB = path.join(tmpArchiveDir, 'codex-cli', '2026', '04', '12');
      fs.mkdirSync(subA, { recursive: true });
      fs.mkdirSync(subB, { recursive: true });
      fs.writeFileSync(path.join(subA, 'one.jsonl'), 'a'.repeat(100));
      fs.writeFileSync(path.join(subA, 'two.jsonl'), 'b'.repeat(250));
      fs.writeFileSync(path.join(subB, 'three.jsonl'), 'c'.repeat(40));
      // Non-jsonl files should be ignored (e.g., macOS .DS_Store, READMEs)
      fs.writeFileSync(path.join(subA, '.DS_Store'), 'noise');
      fs.writeFileSync(path.join(subB, 'NOTES.md'), 'noise');

      const res = await app.inject({ method: 'GET', url: '/api/backups/sessions' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.archive_total_files).toBe(3);
      expect(body.archive_total_bytes).toBe(390);
      expect(body.archive_total_size_human).toMatch(/B$/);
    });

    it('rejects reveal-in-finder requests for paths outside the archive root', async () => {
      await client.query(
        `INSERT INTO settings (key, value, description, value_type) VALUES
         ('sessions.backupEnabled', 'true', 'test', 'boolean'),
         ('sessions.backupPath', $1, 'test', 'string')`,
        [tmpArchiveDir]
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/backups/sessions/reveal',
        payload: { path: '/etc/passwd' },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error).toBe('Path is outside the archive root');
    });

    it('returns 404 when the reveal target does not exist on disk', async () => {
      await client.query(
        `INSERT INTO settings (key, value, description, value_type) VALUES
         ('sessions.backupEnabled', 'true', 'test', 'boolean'),
         ('sessions.backupPath', $1, 'test', 'string')`,
        [tmpArchiveDir]
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/backups/sessions/reveal',
        payload: { path: path.join(tmpArchiveDir, 'missing.jsonl') },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 409 for reveal when session backup is disabled', async () => {
      // No settings inserted — backup disabled by default
      const res = await app.inject({
        method: 'POST',
        url: '/api/backups/sessions/reveal',
        payload: { path: path.join(tmpArchiveDir, 'anything.jsonl') },
      });
      expect(res.statusCode).toBe(409);
    });

    it('returns 400 for reveal when path is missing from the body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/backups/sessions/reveal',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('lists only sessions whose source file is missing but archive copy exists', async () => {
      await client.query(
        `INSERT INTO settings (key, value, description, value_type) VALUES
         ('sessions.backupEnabled', 'true', 'test', 'boolean'),
         ('sessions.backupPath', $1, 'test', 'string')`,
        [tmpArchiveDir]
      );

      const projectDir = '-Users-test-project';
      const presentId = '11111111-1111-1111-1111-111111111111';
      const archivedId = '22222222-2222-2222-2222-222222222222';
      const missingBothId = '33333333-3333-3333-3333-333333333333';

      // Session 1: original file still exists → should be excluded
      const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khef-source-'));
      const presentSource = path.join(sourceRoot, `${presentId}.jsonl`);
      fs.writeFileSync(presentSource, 'live');

      // Session 2: original pruned, archive present → should appear
      const archivePath = path.join(
        tmpArchiveDir,
        'claude-code',
        projectDir,
        `${archivedId}.jsonl`
      );
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.writeFileSync(archivePath, 'archived content');

      // Session 3: original pruned, no archive either → should be excluded
      // (no files created for this one)

      await client.query(
        `INSERT INTO sessions (session_id, assistant_id, project_dir, file_path, file_size, nickname)
         VALUES
           ($1, $2, $3, $4, 4, 'alpha'),
           ($5, $2, $3, $6, 16, 'bravo'),
           ($7, $2, $3, $8, 100, 'charlie')`,
        [
          presentId, assistantId, projectDir, presentSource,
          archivedId, path.join(sourceRoot, `${archivedId}.jsonl`),
          missingBothId, path.join(sourceRoot, `${missingBothId}.jsonl`),
        ]
      );

      const res = await app.inject({ method: 'GET', url: '/api/backups/sessions' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);

      expect(body.enabled).toBe(true);
      expect(body.directory).toBe(path.resolve(tmpArchiveDir));
      expect(body.sessions).toHaveLength(1);

      const only = body.sessions[0];
      expect(only.session_id).toBe(archivedId);
      expect(only.nickname).toBe('bravo');
      expect(only.archive_path).toBe(archivePath);
      expect(only.size).toBe('archived content'.length);
      expect(only.assistant_handle).toBe('claude-code');

      fs.rmSync(sourceRoot, { recursive: true, force: true });
    });
  });
});
