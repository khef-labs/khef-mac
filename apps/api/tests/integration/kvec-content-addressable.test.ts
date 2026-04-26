import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { PgVectorStorage, Collection, ingestDirectory } from '@khef/kvec';
import type { EmbeddingProvider, Chunker, ChunkResult, TrackedFile } from '@khef/kvec';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres@localhost:5433/khef_test';

/** Deterministic fake embedder — produces 4-dim vectors based on content hash */
const fakeEmbedder: EmbeddingProvider = {
  embed: async (texts: string[]) =>
    texts.map((t) => {
      // Simple deterministic "embedding" from first 4 char codes
      const codes = Array.from(t.padEnd(4, '\0').slice(0, 4)).map(
        (c) => c.charCodeAt(0) / 256
      );
      const norm = Math.sqrt(codes.reduce((s, v) => s + v * v, 0)) || 1;
      return codes.map((v) => v / norm);
    }),
  dimensions: () => 4,
  model: () => 'test-4d',
};

/** Simple chunker that produces one chunk per file */
const singleChunker: Chunker = {
  chunk: (text: string): ChunkResult[] => [
    { content: text, index: 0, tokenCount: text.split(/\s+/).length, method: 'test' },
  ],
};

/** Chunker that splits on double-newline (for multi-chunk tests) */
const paragraphChunker: Chunker = {
  chunk: (text: string): ChunkResult[] =>
    text
      .split('\n\n')
      .filter((p) => p.trim().length > 0)
      .map((p, i) => ({
        content: p.trim(),
        index: i,
        tokenCount: p.split(/\s+/).length,
        method: 'paragraph',
      })),
};

let pool: Pool;
let storage: PgVectorStorage;
let tmpDir: string;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DB_URL });
  storage = new PgVectorStorage(pool);
  tmpDir = path.join(os.tmpdir(), `kvec-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterAll(async () => {
  rmSync(tmpDir, { recursive: true, force: true });
  await pool.end();
});

beforeEach(async () => {
  // Clean kvec tables between tests
  await pool.query(`
    DELETE FROM kvec.upload_events;
    DELETE FROM kvec.snapshot_files;
    DELETE FROM kvec.chunks;
    DELETE FROM kvec.tracked_files;
    DELETE FROM kvec.snapshots;
    DELETE FROM kvec.repos;
    DELETE FROM kvec.collections;
  `);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestCollection(name: string, chunker: Chunker = singleChunker) {
  const record = await storage.createCollection({
    name,
    embeddingModel: 'test-4d',
    dimensions: 4,
    storeType: 'mixed',
  });
  return new Collection(record, storage, fakeEmbedder, chunker);
}

function writeTmpFile(relativePath: string, content: string): string {
  const fullPath = path.join(tmpDir, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

function writeTmpBinaryFile(relativePath: string, content: Uint8Array): string {
  const fullPath = path.join(tmpDir, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  return fullPath;
}

async function createRepoAndSnapshot(
  collectionId: string,
  repoName: string,
  branch: string,
  commitHash: string
) {
  const repo = await storage.findOrCreateRepo(collectionId, repoName, tmpDir);
  const snapshot = await storage.findOrCreateSnapshot(repo.id, branch, commitHash);
  return { repo, snapshot };
}

async function getTrackedFiles(collectionId: string): Promise<TrackedFile[]> {
  const result = await pool.query(
    'SELECT * FROM kvec.tracked_files WHERE collection_id = $1 ORDER BY file_path, updated_at DESC',
    [collectionId]
  );
  return result.rows.map((row: any) => ({
    id: row.id,
    collectionId: row.collection_id,
    repoId: row.repo_id,
    filePath: row.file_path,
    contentHash: row.content_hash,
    fileSize: Number(row.file_size),
    language: row.language,
    status: row.status,
    errorMessage: row.error_message,
    metadata: row.metadata,
    uploadedAt: row.uploaded_at,
    updatedAt: row.updated_at,
  }));
}

async function getSnapshotLinks(fileId: string): Promise<string[]> {
  const result = await pool.query(
    'SELECT snapshot_id FROM kvec.snapshot_files WHERE file_id = $1',
    [fileId]
  );
  return result.rows.map((r: any) => r.snapshot_id);
}

async function getChunkCount(fileId: string): Promise<number> {
  const result = await pool.query(
    'SELECT COUNT(*) AS cnt FROM kvec.chunks WHERE file_id = $1',
    [fileId]
  );
  return parseInt(result.rows[0].cnt, 10);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('kvec content-addressable files', () => {
  it('skips binary files without creating tracked rows', async () => {
    const coll = await createTestCollection('binary-skip');
    const filePath = writeTmpBinaryFile('tmp/images/IMG_1634.png', new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
    ]));

    const chunks = await coll.ingest(filePath);

    expect(chunks).toBe(0);
    expect(await getTrackedFiles(coll.id)).toHaveLength(0);
  });

  it('accepts a single file path in ingestDirectory', async () => {
    const coll = await createTestCollection('single-file');
    const filePath = writeTmpFile('single.ts', 'export const answer = 42;');

    const result = await ingestDirectory(coll, filePath);

    expect(result.filesProcessed).toBe(1);
    expect(result.filesSkipped).toBe(0);
    expect(result.filesErrored).toBe(0);
    expect(await getTrackedFiles(coll.id)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Basic idempotency
  // -------------------------------------------------------------------------

  describe('idempotent ingest', () => {
    it('ingesting the same file twice with same content creates one row', async () => {
      const coll = await createTestCollection('idem-1');
      const filePath = writeTmpFile('a.ts', 'const x = 1;');

      const chunks1 = await coll.ingest(filePath, {
        repoName: 'test-repo',
        repoRootPath: tmpDir,
        branch: 'main',
        commitHash: 'aaa111',
      });
      const chunks2 = await coll.ingest(filePath, {
        repoName: 'test-repo',
        repoRootPath: tmpDir,
        branch: 'main',
        commitHash: 'aaa111',
      });

      expect(chunks1).toBeGreaterThan(0);
      expect(chunks2).toBe(0); // skipped

      const files = await getTrackedFiles(coll.id);
      expect(files).toHaveLength(1);
    });

    it('ingesting same file from different commits on same branch skips if unchanged', async () => {
      const coll = await createTestCollection('idem-2');
      const filePath = writeTmpFile('b.ts', 'const y = 2;');

      await coll.ingest(filePath, {
        repoName: 'test-repo',
        repoRootPath: tmpDir,
        branch: 'main',
        commitHash: 'bbb111',
      });
      const chunks2 = await coll.ingest(filePath, {
        repoName: 'test-repo',
        repoRootPath: tmpDir,
        branch: 'main',
        commitHash: 'bbb222',
      });

      expect(chunks2).toBe(0); // unchanged content

      const files = await getTrackedFiles(coll.id);
      expect(files).toHaveLength(1);

      // Both snapshots should be linked
      const links = await getSnapshotLinks(files[0].id);
      expect(links).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-branch behavior
  // -------------------------------------------------------------------------

  describe('cross-branch', () => {
    it('same file same content across branches shares one row', async () => {
      const coll = await createTestCollection('cross-1');
      const filePath = writeTmpFile('shared.ts', 'export const shared = true;');

      await coll.ingest(filePath, {
        repoName: 'test-repo',
        repoRootPath: tmpDir,
        branch: 'main',
        commitHash: 'ccc111',
      });
      const chunks2 = await coll.ingest(filePath, {
        repoName: 'test-repo',
        repoRootPath: tmpDir,
        branch: 'feature',
        commitHash: 'ccc222',
      });

      expect(chunks2).toBe(0); // same content, skipped

      const files = await getTrackedFiles(coll.id);
      expect(files).toHaveLength(1);

      // Linked to both snapshots (one per branch)
      const links = await getSnapshotLinks(files[0].id);
      expect(links).toHaveLength(2);
    });

    it('same file different content across branches creates separate rows', async () => {
      const coll = await createTestCollection('cross-2');
      const filePath = writeTmpFile('diverge.ts', 'const version = "main";');

      await coll.ingest(filePath, {
        repoName: 'test-repo',
        repoRootPath: tmpDir,
        branch: 'main',
        commitHash: 'ddd111',
      });

      // Change the file content (simulating different branch content)
      writeTmpFile('diverge.ts', 'const version = "feature";');

      const chunks2 = await coll.ingest(filePath, {
        repoName: 'test-repo',
        repoRootPath: tmpDir,
        branch: 'feature',
        commitHash: 'ddd222',
      });

      expect(chunks2).toBeGreaterThan(0); // new version created

      const files = await getTrackedFiles(coll.id);
      expect(files).toHaveLength(2); // two versions

      // Each version linked to its own snapshot
      for (const file of files) {
        const links = await getSnapshotLinks(file.id);
        expect(links).toHaveLength(1);
      }
    });

    it('ingesting is order-independent — branch A then B same as B then A', async () => {
      // Run A then B
      const coll1 = await createTestCollection('order-ab');
      const fileAB = writeTmpFile('order-ab.ts', 'version A');
      await coll1.ingest(fileAB, {
        repoName: 'test-repo', repoRootPath: tmpDir,
        branch: 'main', commitHash: 'eee111',
      });
      writeTmpFile('order-ab.ts', 'version B');
      await coll1.ingest(fileAB, {
        repoName: 'test-repo', repoRootPath: tmpDir,
        branch: 'feature', commitHash: 'eee222',
      });

      // Run B then A
      const coll2 = await createTestCollection('order-ba');
      const fileBA = writeTmpFile('order-ba.ts', 'version B');
      await coll2.ingest(fileBA, {
        repoName: 'test-repo', repoRootPath: tmpDir,
        branch: 'feature', commitHash: 'fff222',
      });
      writeTmpFile('order-ba.ts', 'version A');
      await coll2.ingest(fileBA, {
        repoName: 'test-repo', repoRootPath: tmpDir,
        branch: 'main', commitHash: 'fff111',
      });

      // Both should have 2 tracked files
      const files1 = await getTrackedFiles(coll1.id);
      const files2 = await getTrackedFiles(coll2.id);
      expect(files1).toHaveLength(2);
      expect(files2).toHaveLength(2);

      // Both should have same set of content hashes
      const hashes1 = files1.map((f) => f.contentHash).sort();
      const hashes2 = files2.map((f) => f.contentHash).sort();
      expect(hashes1).toEqual(hashes2);
    });
  });

  // -------------------------------------------------------------------------
  // Snapshot linking
  // -------------------------------------------------------------------------

  describe('snapshot links', () => {
    it('links multiple snapshots to the same file', async () => {
      const coll = await createTestCollection('snap-1');
      const filePath = writeTmpFile('stable.ts', 'unchanged content');

      // Ingest across 3 commits
      for (const hash of ['aaa', 'bbb', 'ccc']) {
        await coll.ingest(filePath, {
          repoName: 'test-repo',
          repoRootPath: tmpDir,
          branch: 'main',
          commitHash: hash,
        });
      }

      const files = await getTrackedFiles(coll.id);
      expect(files).toHaveLength(1);

      const links = await getSnapshotLinks(files[0].id);
      expect(links).toHaveLength(3);
    });

    it('does not create snapshot links for non-git ingestion', async () => {
      const coll = await createTestCollection('snap-2');
      const filePath = writeTmpFile('no-git.ts', 'no git info');

      // Ingest without repo/branch/commit opts
      await coll.ingest(filePath);

      const files = await getTrackedFiles(coll.id);
      expect(files).toHaveLength(1);

      const links = await getSnapshotLinks(files[0].id);
      expect(links).toHaveLength(0);
    });

    it('linkSnapshot is idempotent', async () => {
      const coll = await createTestCollection('snap-3');
      const { repo, snapshot } = await createRepoAndSnapshot(
        coll.id, 'test-repo', 'main', 'xxx111'
      );

      const trackedFile = await storage.upsertTrackedFile({
        collectionId: coll.id,
        repoId: repo.id,
        filePath: 'idem-link.ts',
        contentHash: 'hash123',
        fileSize: 100,
        language: 'typescript',
        status: 'active',
        errorMessage: null,
        metadata: null,
      });

      // Link the same snapshot twice
      await storage.linkSnapshot(snapshot.id, trackedFile.id);
      await storage.linkSnapshot(snapshot.id, trackedFile.id);

      const links = await getSnapshotLinks(trackedFile.id);
      expect(links).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Query deduplication
  // -------------------------------------------------------------------------

  describe('query dedup', () => {
    it('unfiltered query returns only the latest version per file', async () => {
      const coll = await createTestCollection('dedup-1');

      // Create two versions of the same file via storage directly
      const { repo, snapshot: snap1 } = await createRepoAndSnapshot(
        coll.id, 'test-repo', 'main', 'ggg111'
      );

      const file1 = await storage.upsertTrackedFile({
        collectionId: coll.id,
        repoId: repo.id,
        filePath: 'dedup.ts',
        contentHash: 'old-hash',
        fileSize: 50,
        language: 'typescript',
        status: 'active',
        errorMessage: null,
        metadata: null,
      });

      const [emb1] = await fakeEmbedder.embed(['old content']);
      await storage.upsertChunks(coll.id, file1.id, [
        { chunkIndex: 0, content: 'old content', embedding: emb1, tokenCount: 2, chunkMethod: 'test' },
      ]);
      await storage.linkSnapshot(snap1.id, file1.id);

      // Wait a tick so updated_at differs
      await new Promise((r) => setTimeout(r, 50));

      const snap2 = await storage.findOrCreateSnapshot(repo.id, 'main', 'ggg222');
      const file2 = await storage.upsertTrackedFile({
        collectionId: coll.id,
        repoId: repo.id,
        filePath: 'dedup.ts',
        contentHash: 'new-hash',
        fileSize: 60,
        language: 'typescript',
        status: 'active',
        errorMessage: null,
        metadata: null,
      });

      const [emb2] = await fakeEmbedder.embed(['new content']);
      await storage.upsertChunks(coll.id, file2.id, [
        { chunkIndex: 0, content: 'new content', embedding: emb2, tokenCount: 2, chunkMethod: 'test' },
      ]);
      await storage.linkSnapshot(snap2.id, file2.id);

      // Verify both versions exist
      const files = await getTrackedFiles(coll.id);
      expect(files).toHaveLength(2);

      // Unfiltered query should only return the latest version
      const results = await coll.query('content', { limit: 10 });
      const dedupPaths = results.map((r) => r.filePath);
      // Should have at most one result for dedup.ts
      expect(dedupPaths.filter((p) => p === 'dedup.ts')).toHaveLength(1);
      // And it should be from the newer file
      expect(results.find((r) => r.filePath === 'dedup.ts')?.fileId).toBe(file2.id);
    });

    it('branch-filtered query returns version linked to that branch', async () => {
      const coll = await createTestCollection('dedup-2');
      const { repo } = await createRepoAndSnapshot(
        coll.id, 'test-repo', 'main', 'hhh111'
      );

      // Version on main
      const mainSnap = await storage.findOrCreateSnapshot(repo.id, 'main', 'hhh111');
      const mainFile = await storage.upsertTrackedFile({
        collectionId: coll.id,
        repoId: repo.id,
        filePath: 'branched.ts',
        contentHash: 'main-hash',
        fileSize: 50,
        language: 'typescript',
        status: 'active',
        errorMessage: null,
        metadata: null,
      });
      const [mainEmb] = await fakeEmbedder.embed(['main version of branched file']);
      await storage.upsertChunks(coll.id, mainFile.id, [
        { chunkIndex: 0, content: 'main version of branched file', embedding: mainEmb, tokenCount: 5, chunkMethod: 'test' },
      ]);
      await storage.linkSnapshot(mainSnap.id, mainFile.id);

      // Version on feature
      const featSnap = await storage.findOrCreateSnapshot(repo.id, 'feature', 'iii222');
      const featFile = await storage.upsertTrackedFile({
        collectionId: coll.id,
        repoId: repo.id,
        filePath: 'branched.ts',
        contentHash: 'feature-hash',
        fileSize: 60,
        language: 'typescript',
        status: 'active',
        errorMessage: null,
        metadata: null,
      });
      const [featEmb] = await fakeEmbedder.embed(['feature version of branched file']);
      await storage.upsertChunks(coll.id, featFile.id, [
        { chunkIndex: 0, content: 'feature version of branched file', embedding: featEmb, tokenCount: 5, chunkMethod: 'test' },
      ]);
      await storage.linkSnapshot(featSnap.id, featFile.id);

      // Query with branch=main → should get main version
      const mainResults = await coll.query('branched file', { branch: 'main', limit: 10 });
      expect(mainResults).toHaveLength(1);
      expect(mainResults[0].fileId).toBe(mainFile.id);

      // Query with branch=feature → should get feature version
      const featResults = await coll.query('branched file', { branch: 'feature', limit: 10 });
      expect(featResults).toHaveLength(1);
      expect(featResults[0].fileId).toBe(featFile.id);
    });
  });

  // -------------------------------------------------------------------------
  // Query with branch/commit filters — comprehensive scenarios
  // -------------------------------------------------------------------------

  describe('query filters', () => {
    /**
     * Shared setup: a repo with 3 branches and multiple commits.
     *
     *   main:    commit-m1 (utils.ts v1, config.ts v1)
     *            commit-m2 (utils.ts v2, config.ts v1 unchanged)
     *   feature: commit-f1 (utils.ts v1 same as main m1, config.ts v3 different)
     *   hotfix:  commit-h1 (utils.ts v2 same as main m2, config.ts v1 same as main m1)
     */
    async function setupMultiBranchRepo() {
      const coll = await createTestCollection('qf-multi');
      const repo = await storage.findOrCreateRepo(coll.id, 'multi-repo', tmpDir);

      // Helper to create a file version with chunks and snapshot link
      async function addFileVersion(
        filePath: string,
        content: string,
        branch: string,
        commitHash: string,
      ) {
        const contentHash = require('crypto').createHash('sha256').update(content).digest('hex');
        const snap = await storage.findOrCreateSnapshot(repo.id, branch, commitHash);

        // Check if this exact version already exists
        const existing = await storage.findTrackedFile(coll.id, filePath, repo.id, contentHash);
        if (existing) {
          await storage.linkSnapshot(snap.id, existing.id);
          return existing;
        }

        const file = await storage.upsertTrackedFile({
          collectionId: coll.id,
          repoId: repo.id,
          filePath,
          contentHash,
          fileSize: content.length,
          language: 'typescript',
          status: 'active',
          errorMessage: null,
          metadata: null,
        });

        const [emb] = await fakeEmbedder.embed([content]);
        await storage.upsertChunks(coll.id, file.id, [
          { chunkIndex: 0, content, embedding: emb, tokenCount: content.split(/\s+/).length, chunkMethod: 'test' },
        ]);
        await storage.linkSnapshot(snap.id, file.id);
        return file;
      }

      // main commit-m1: utils.ts v1 + config.ts v1
      const utilsV1 = await addFileVersion('utils.ts', 'export function util() { return 1; }', 'main', 'commit-m1');
      const configV1 = await addFileVersion('config.ts', 'export const config = { port: 3000 };', 'main', 'commit-m1');

      // main commit-m2: utils.ts v2 (changed) + config.ts v1 (unchanged)
      const utilsV2 = await addFileVersion('utils.ts', 'export function util() { return 2; /* updated */ }', 'main', 'commit-m2');
      /* configV1 reused */ await addFileVersion('config.ts', 'export const config = { port: 3000 };', 'main', 'commit-m2');

      // feature commit-f1: utils.ts v1 (same as main m1) + config.ts v3 (different)
      /* utilsV1 reused */ await addFileVersion('utils.ts', 'export function util() { return 1; }', 'feature', 'commit-f1');
      const configV3 = await addFileVersion('config.ts', 'export const config = { port: 8080, debug: true };', 'feature', 'commit-f1');

      // hotfix commit-h1: utils.ts v2 (same as main m2) + config.ts v1 (same as main m1)
      /* utilsV2 reused */ await addFileVersion('utils.ts', 'export function util() { return 2; /* updated */ }', 'hotfix', 'commit-h1');
      /* configV1 reused */ await addFileVersion('config.ts', 'export const config = { port: 3000 };', 'hotfix', 'commit-h1');

      return { coll, repo, utilsV1, utilsV2, configV1, configV3 };
    }

    it('commit filter returns only files linked to that specific commit', async () => {
      const { coll, utilsV1, configV1 } = await setupMultiBranchRepo();

      // commit-m1 should have utils v1 + config v1
      const results = await coll.query('export', { commitHash: 'commit-m1', limit: 10 });
      const fileIds = results.map((r) => r.fileId);
      expect(fileIds).toContain(utilsV1.id);
      expect(fileIds).toContain(configV1.id);
      expect(new Set(fileIds).size).toBe(2); // exactly 2 distinct files
    });

    it('commit filter for later commit includes updated files', async () => {
      const { coll, utilsV2, configV1 } = await setupMultiBranchRepo();

      // commit-m2 should have utils v2 + config v1
      const results = await coll.query('export', { commitHash: 'commit-m2', limit: 10 });
      const fileIds = results.map((r) => r.fileId);
      expect(fileIds).toContain(utilsV2.id);
      expect(fileIds).toContain(configV1.id);
    });

    it('branch filter returns all files linked to any commit on that branch', async () => {
      const { coll, utilsV1, utilsV2, configV1 } = await setupMultiBranchRepo();

      // main branch has: utils v1 (m1), utils v2 (m2), config v1 (m1+m2)
      const results = await coll.query('export', { branch: 'main', limit: 10 });
      const fileIds = new Set(results.map((r) => r.fileId));

      // Both versions of utils appear (linked to different commits on main)
      expect(fileIds.has(utilsV1.id)).toBe(true);
      expect(fileIds.has(utilsV2.id)).toBe(true);
      expect(fileIds.has(configV1.id)).toBe(true);
    });

    it('feature branch has its own config version but shares utils with main', async () => {
      const { coll, utilsV1, configV3 } = await setupMultiBranchRepo();

      // feature branch: utils v1 (shared with main m1) + config v3 (unique)
      const results = await coll.query('export', { branch: 'feature', limit: 10 });
      const fileIds = new Set(results.map((r) => r.fileId));

      expect(fileIds.has(utilsV1.id)).toBe(true);
      expect(fileIds.has(configV3.id)).toBe(true);
      expect(fileIds.size).toBe(2);
    });

    it('hotfix branch shares files with main but not feature config', async () => {
      const { coll, utilsV2, configV1, configV3 } = await setupMultiBranchRepo();

      const results = await coll.query('export', { branch: 'hotfix', limit: 10 });
      const fileIds = new Set(results.map((r) => r.fileId));

      // hotfix has utils v2 + config v1 (shared with main)
      expect(fileIds.has(utilsV2.id)).toBe(true);
      expect(fileIds.has(configV1.id)).toBe(true);
      // Should NOT have feature's config v3
      expect(fileIds.has(configV3.id)).toBe(false);
    });

    it('non-existent branch returns no results', async () => {
      const { coll } = await setupMultiBranchRepo();
      const results = await coll.query('export', { branch: 'ghost-branch', limit: 10 });
      expect(results).toHaveLength(0);
    });

    it('non-existent commit returns no results', async () => {
      const { coll } = await setupMultiBranchRepo();
      const results = await coll.query('export', { commitHash: 'nonexistent', limit: 10 });
      expect(results).toHaveLength(0);
    });

    it('combined branch + commit filter narrows to exact snapshot', async () => {
      const { coll, utilsV1, configV1 } = await setupMultiBranchRepo();

      // branch=main + commit=commit-m1 → only m1 snapshot
      const results = await coll.query('export', {
        branch: 'main',
        commitHash: 'commit-m1',
        limit: 10,
      });
      const fileIds = new Set(results.map((r) => r.fileId));
      expect(fileIds.has(utilsV1.id)).toBe(true);
      expect(fileIds.has(configV1.id)).toBe(true);
      expect(fileIds.size).toBe(2);
    });

    it('unfiltered query deduplicates across all branches', async () => {
      const { coll } = await setupMultiBranchRepo();

      // Without filters, should return latest version of each file path
      const results = await coll.query('export', { limit: 10 });

      // Group results by file_path
      const byPath = new Map<string, typeof results>();
      for (const r of results) {
        const arr = byPath.get(r.filePath) || [];
        arr.push(r);
        byPath.set(r.filePath, arr);
      }

      // Each file path should appear at most once (dedup picks latest)
      for (const [filePath, pathResults] of byPath) {
        const uniqueFileIds = new Set(pathResults.map((r) => r.fileId));
        expect(uniqueFileIds.size).toBe(1);
      }
    });

    it('language filter works alongside branch filter', async () => {
      const coll = await createTestCollection('qf-lang');
      const repo = await storage.findOrCreateRepo(coll.id, 'lang-repo', tmpDir);
      const snap = await storage.findOrCreateSnapshot(repo.id, 'main', 'lang-1');

      // TypeScript file
      const tsFile = await storage.upsertTrackedFile({
        collectionId: coll.id,
        repoId: repo.id,
        filePath: 'app.ts',
        contentHash: 'ts-hash',
        fileSize: 50,
        language: 'typescript',
        status: 'active',
        errorMessage: null,
        metadata: null,
      });
      const [tsEmb] = await fakeEmbedder.embed(['typescript app code']);
      await storage.upsertChunks(coll.id, tsFile.id, [
        { chunkIndex: 0, content: 'typescript app code', embedding: tsEmb, tokenCount: 3, chunkMethod: 'test' },
      ]);
      await storage.linkSnapshot(snap.id, tsFile.id);

      // Python file
      const pyFile = await storage.upsertTrackedFile({
        collectionId: coll.id,
        repoId: repo.id,
        filePath: 'app.py',
        contentHash: 'py-hash',
        fileSize: 50,
        language: 'python',
        status: 'active',
        errorMessage: null,
        metadata: null,
      });
      const [pyEmb] = await fakeEmbedder.embed(['python app code']);
      await storage.upsertChunks(coll.id, pyFile.id, [
        { chunkIndex: 0, content: 'python app code', embedding: pyEmb, tokenCount: 3, chunkMethod: 'test' },
      ]);
      await storage.linkSnapshot(snap.id, pyFile.id);

      // Filter by language=typescript on branch=main
      const tsResults = await coll.query('app code', { branch: 'main', language: 'typescript', limit: 10 });
      expect(tsResults).toHaveLength(1);
      expect(tsResults[0].language).toBe('typescript');

      // Filter by language=python on branch=main
      const pyResults = await coll.query('app code', { branch: 'main', language: 'python', limit: 10 });
      expect(pyResults).toHaveLength(1);
      expect(pyResults[0].language).toBe('python');
    });

    it('repo filter isolates results to named repo', async () => {
      const coll = await createTestCollection('qf-repo');
      const repoA = await storage.findOrCreateRepo(coll.id, 'repo-alpha', tmpDir);
      const repoB = await storage.findOrCreateRepo(coll.id, 'repo-beta', tmpDir + '/beta');

      // File in repo-alpha
      const fileA = await storage.upsertTrackedFile({
        collectionId: coll.id,
        repoId: repoA.id,
        filePath: 'shared-name.ts',
        contentHash: 'alpha-hash',
        fileSize: 50,
        language: 'typescript',
        status: 'active',
        errorMessage: null,
        metadata: null,
      });
      const [embA] = await fakeEmbedder.embed(['alpha repo content']);
      await storage.upsertChunks(coll.id, fileA.id, [
        { chunkIndex: 0, content: 'alpha repo content', embedding: embA, tokenCount: 3, chunkMethod: 'test' },
      ]);

      // Same file name in repo-beta with different content
      const fileB = await storage.upsertTrackedFile({
        collectionId: coll.id,
        repoId: repoB.id,
        filePath: 'shared-name.ts',
        contentHash: 'beta-hash',
        fileSize: 60,
        language: 'typescript',
        status: 'active',
        errorMessage: null,
        metadata: null,
      });
      const [embB] = await fakeEmbedder.embed(['beta repo content']);
      await storage.upsertChunks(coll.id, fileB.id, [
        { chunkIndex: 0, content: 'beta repo content', embedding: embB, tokenCount: 3, chunkMethod: 'test' },
      ]);

      const alphaResults = await coll.query('repo content', { repoName: 'repo-alpha', limit: 10 });
      expect(alphaResults).toHaveLength(1);
      expect(alphaResults[0].fileId).toBe(fileA.id);

      const betaResults = await coll.query('repo content', { repoName: 'repo-beta', limit: 10 });
      expect(betaResults).toHaveLength(1);
      expect(betaResults[0].fileId).toBe(fileB.id);
    });

    it('minScore filter excludes low-similarity results', async () => {
      const coll = await createTestCollection('qf-score');
      const repo = await storage.findOrCreateRepo(coll.id, 'score-repo', tmpDir);

      // Two files with very different content
      for (const [filePath, content, hash] of [
        ['relevant.ts', 'search query matching content', 'rel-hash'],
        ['unrelated.ts', 'zzzzzzzzzzzzzzz', 'unrel-hash'],
      ] as const) {
        const file = await storage.upsertTrackedFile({
          collectionId: coll.id,
          repoId: repo.id,
          filePath,
          contentHash: hash,
          fileSize: content.length,
          language: 'typescript',
          status: 'active',
          errorMessage: null,
          metadata: null,
        });
        const [emb] = await fakeEmbedder.embed([content]);
        await storage.upsertChunks(coll.id, file.id, [
          { chunkIndex: 0, content, embedding: emb, tokenCount: content.split(/\s+/).length, chunkMethod: 'test' },
        ]);
      }

      // Without minScore: both appear
      const all = await coll.query('search query matching content', { limit: 10 });
      expect(all.length).toBeGreaterThanOrEqual(1);

      // With high minScore: only the relevant one
      const filtered = await coll.query('search query matching content', { minScore: 0.9, limit: 10 });
      for (const r of filtered) {
        expect(r.score).toBeGreaterThanOrEqual(0.9);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Non-git content (ingestContent) — single-version behavior
  // -------------------------------------------------------------------------

  describe('ingestContent (non-git)', () => {
    it('replaces old version when content changes', async () => {
      const coll = await createTestCollection('content-1');

      const chunks1 = await coll.ingestContent('doc-1', 'initial content');
      expect(chunks1).toBeGreaterThan(0);

      const chunks2 = await coll.ingestContent('doc-1', 'updated content');
      expect(chunks2).toBeGreaterThan(0);

      // Should have exactly one tracked file (old version deleted)
      const files = await getTrackedFiles(coll.id);
      const docFiles = files.filter((f) => f.filePath === 'doc-1');
      expect(docFiles).toHaveLength(1);
      expect(docFiles[0].contentHash).not.toBe(
        // Verify it's the new content hash
        require('crypto').createHash('sha256').update('initial content').digest('hex')
      );
    });

    it('skips if content unchanged', async () => {
      const coll = await createTestCollection('content-2');

      await coll.ingestContent('doc-2', 'same content');
      const chunks2 = await coll.ingestContent('doc-2', 'same content');

      expect(chunks2).toBe(0); // skipped
    });

    it('old chunks are cleaned up on content change', async () => {
      const coll = await createTestCollection('content-3', paragraphChunker);

      await coll.ingestContent('doc-3', 'paragraph one\n\nparagraph two\n\nparagraph three');

      const filesBefore = await getTrackedFiles(coll.id);
      const chunksBefore = await getChunkCount(filesBefore[0].id);
      expect(chunksBefore).toBe(3);

      // Update with fewer paragraphs
      await coll.ingestContent('doc-3', 'single paragraph');

      const filesAfter = await getTrackedFiles(coll.id);
      expect(filesAfter).toHaveLength(1);
      const chunksAfter = await getChunkCount(filesAfter[0].id);
      expect(chunksAfter).toBe(1);

      // Old file's chunks should be gone (cascade delete)
      const oldChunks = await getChunkCount(filesBefore[0].id);
      expect(oldChunks).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // findTrackedFile behavior
  // -------------------------------------------------------------------------

  describe('findTrackedFile', () => {
    it('finds exact match by content hash', async () => {
      const coll = await createTestCollection('find-1');
      const repo = await storage.findOrCreateRepo(coll.id, 'test-repo', tmpDir);

      await storage.upsertTrackedFile({
        collectionId: coll.id,
        repoId: repo.id,
        filePath: 'find-me.ts',
        contentHash: 'hash-alpha',
        fileSize: 100,
        language: 'typescript',
        status: 'active',
        errorMessage: null,
        metadata: null,
      });

      await storage.upsertTrackedFile({
        collectionId: coll.id,
        repoId: repo.id,
        filePath: 'find-me.ts',
        contentHash: 'hash-beta',
        fileSize: 110,
        language: 'typescript',
        status: 'active',
        errorMessage: null,
        metadata: null,
      });

      // Find with specific hash
      const alpha = await storage.findTrackedFile(coll.id, 'find-me.ts', repo.id, 'hash-alpha');
      expect(alpha).not.toBeNull();
      expect(alpha!.contentHash).toBe('hash-alpha');

      const beta = await storage.findTrackedFile(coll.id, 'find-me.ts', repo.id, 'hash-beta');
      expect(beta).not.toBeNull();
      expect(beta!.contentHash).toBe('hash-beta');

      // Non-existent hash
      const missing = await storage.findTrackedFile(coll.id, 'find-me.ts', repo.id, 'hash-gamma');
      expect(missing).toBeNull();
    });

    it('without content hash, returns the latest version', async () => {
      const coll = await createTestCollection('find-2');
      const repo = await storage.findOrCreateRepo(coll.id, 'test-repo', tmpDir);

      await storage.upsertTrackedFile({
        collectionId: coll.id,
        repoId: repo.id,
        filePath: 'latest.ts',
        contentHash: 'hash-old',
        fileSize: 100,
        language: 'typescript',
        status: 'active',
        errorMessage: null,
        metadata: null,
      });

      await new Promise((r) => setTimeout(r, 50));

      await storage.upsertTrackedFile({
        collectionId: coll.id,
        repoId: repo.id,
        filePath: 'latest.ts',
        contentHash: 'hash-new',
        fileSize: 110,
        language: 'typescript',
        status: 'active',
        errorMessage: null,
        metadata: null,
      });

      const found = await storage.findTrackedFile(coll.id, 'latest.ts', repo.id);
      expect(found).not.toBeNull();
      expect(found!.contentHash).toBe('hash-new');
    });
  });

  // -------------------------------------------------------------------------
  // Unique constraint enforcement
  // -------------------------------------------------------------------------

  describe('unique constraint', () => {
    it('allows same path with different content hashes', async () => {
      const coll = await createTestCollection('uniq-1');
      const repo = await storage.findOrCreateRepo(coll.id, 'test-repo', tmpDir);

      const f1 = await storage.upsertTrackedFile({
        collectionId: coll.id,
        repoId: repo.id,
        filePath: 'multi.ts',
        contentHash: 'hash-v1',
        fileSize: 100,
        language: 'typescript',
        status: 'active',
        errorMessage: null,
        metadata: null,
      });

      const f2 = await storage.upsertTrackedFile({
        collectionId: coll.id,
        repoId: repo.id,
        filePath: 'multi.ts',
        contentHash: 'hash-v2',
        fileSize: 200,
        language: 'typescript',
        status: 'active',
        errorMessage: null,
        metadata: null,
      });

      // Different IDs — two separate rows
      expect(f1.id).not.toBe(f2.id);
      expect(f1.contentHash).toBe('hash-v1');
      expect(f2.contentHash).toBe('hash-v2');
    });

    it('upserts (no duplicate) for same path + same content hash', async () => {
      const coll = await createTestCollection('uniq-2');
      const repo = await storage.findOrCreateRepo(coll.id, 'test-repo', tmpDir);

      const f1 = await storage.upsertTrackedFile({
        collectionId: coll.id,
        repoId: repo.id,
        filePath: 'same.ts',
        contentHash: 'hash-same',
        fileSize: 100,
        language: 'typescript',
        status: 'active',
        errorMessage: null,
        metadata: null,
      });

      const f2 = await storage.upsertTrackedFile({
        collectionId: coll.id,
        repoId: repo.id,
        filePath: 'same.ts',
        contentHash: 'hash-same',
        fileSize: 100,
        language: 'typescript',
        status: 'active',
        errorMessage: null,
        metadata: null,
      });

      // Same ID — upserted in place
      expect(f1.id).toBe(f2.id);
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end: simulate multi-commit workflow
  // -------------------------------------------------------------------------

  describe('multi-commit workflow', () => {
    it('handles realistic git workflow across 3 commits', async () => {
      const coll = await createTestCollection('workflow-1');

      // Commit 1: two files
      const fileA = writeTmpFile('src/a.ts', 'export const a = 1;');
      const fileB = writeTmpFile('src/b.ts', 'export const b = 2;');

      await coll.ingest(fileA, {
        repoName: 'my-repo', repoRootPath: tmpDir,
        branch: 'main', commitHash: 'commit-1',
      });
      await coll.ingest(fileB, {
        repoName: 'my-repo', repoRootPath: tmpDir,
        branch: 'main', commitHash: 'commit-1',
      });

      let files = await getTrackedFiles(coll.id);
      expect(files).toHaveLength(2);

      // Commit 2: a.ts changed, b.ts unchanged
      writeTmpFile('src/a.ts', 'export const a = 100; // updated');

      const chunksA2 = await coll.ingest(fileA, {
        repoName: 'my-repo', repoRootPath: tmpDir,
        branch: 'main', commitHash: 'commit-2',
      });
      const chunksB2 = await coll.ingest(fileB, {
        repoName: 'my-repo', repoRootPath: tmpDir,
        branch: 'main', commitHash: 'commit-2',
      });

      expect(chunksA2).toBeGreaterThan(0); // new version
      expect(chunksB2).toBe(0); // skipped

      files = await getTrackedFiles(coll.id);
      expect(files).toHaveLength(3); // 2 versions of a.ts + 1 b.ts

      // Commit 3: new file c.ts, a.ts back to original, b.ts unchanged
      writeTmpFile('src/a.ts', 'export const a = 1;'); // reverted
      const fileC = writeTmpFile('src/c.ts', 'export const c = 3;');

      const chunksA3 = await coll.ingest(fileA, {
        repoName: 'my-repo', repoRootPath: tmpDir,
        branch: 'main', commitHash: 'commit-3',
      });
      const chunksB3 = await coll.ingest(fileB, {
        repoName: 'my-repo', repoRootPath: tmpDir,
        branch: 'main', commitHash: 'commit-3',
      });
      const chunksC3 = await coll.ingest(fileC, {
        repoName: 'my-repo', repoRootPath: tmpDir,
        branch: 'main', commitHash: 'commit-3',
      });

      expect(chunksA3).toBe(0); // content matches commit-1's version (reused!)
      expect(chunksB3).toBe(0); // still unchanged
      expect(chunksC3).toBeGreaterThan(0); // new file

      files = await getTrackedFiles(coll.id);
      // a.ts v1 (commit-1 + commit-3), a.ts v2 (commit-2), b.ts (all 3), c.ts (commit-3)
      expect(files).toHaveLength(4);

      // Verify a.ts v1 is linked to both commit-1 and commit-3
      const aV1 = files.find(
        (f) => f.filePath.endsWith('a.ts') &&
          f.contentHash === require('crypto').createHash('sha256').update('export const a = 1;').digest('hex')
      );
      expect(aV1).toBeDefined();
      const aV1Links = await getSnapshotLinks(aV1!.id);
      expect(aV1Links).toHaveLength(2); // commit-1 and commit-3

      // Verify b.ts is linked to all 3 commits
      const bFile = files.find((f) => f.filePath.endsWith('b.ts'));
      expect(bFile).toBeDefined();
      const bLinks = await getSnapshotLinks(bFile!.id);
      expect(bLinks).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Chunk isolation between versions
  // -------------------------------------------------------------------------

  describe('chunk isolation', () => {
    it('each version has its own independent chunks', async () => {
      const coll = await createTestCollection('chunks-1', paragraphChunker);
      const filePath = writeTmpFile('chunked.ts', 'para one\n\npara two');

      await coll.ingest(filePath, {
        repoName: 'test-repo', repoRootPath: tmpDir,
        branch: 'main', commitHash: 'jjj111',
      });

      // Change content → new version with different chunks
      writeTmpFile('chunked.ts', 'alpha\n\nbeta\n\ngamma');

      await coll.ingest(filePath, {
        repoName: 'test-repo', repoRootPath: tmpDir,
        branch: 'feature', commitHash: 'jjj222',
      });

      const files = await getTrackedFiles(coll.id);
      expect(files).toHaveLength(2);

      const oldHash = require('crypto').createHash('sha256').update('para one\n\npara two').digest('hex');
      const oldFile = files.find((f) => f.contentHash === oldHash)!;
      expect(oldFile).toBeDefined();
      expect(await getChunkCount(oldFile.id)).toBe(2);

      const newHash = require('crypto').createHash('sha256').update('alpha\n\nbeta\n\ngamma').digest('hex');
      const newFile = files.find((f) => f.contentHash === newHash)!;
      expect(newFile).toBeDefined();
      expect(await getChunkCount(newFile.id)).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // deleteDocument for non-git content
  // -------------------------------------------------------------------------

  describe('deleteDocument', () => {
    it('deletes tracked file and its chunks', async () => {
      const coll = await createTestCollection('del-1');
      await coll.ingestContent('to-delete', 'some content to delete');

      const deleted = await coll.deleteDocument('to-delete');
      expect(deleted).toBe(true);

      const files = await getTrackedFiles(coll.id);
      expect(files.filter((f) => f.filePath === 'to-delete')).toHaveLength(0);
    });

    it('returns false for non-existent document', async () => {
      const coll = await createTestCollection('del-2');
      const deleted = await coll.deleteDocument('ghost');
      expect(deleted).toBe(false);
    });
  });
});
