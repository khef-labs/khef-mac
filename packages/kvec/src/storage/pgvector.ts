import { Pool, PoolClient } from 'pg';
import pgvector from 'pgvector/pg';
import {
  StorageBackend,
  CollectionRecord,
  CreateCollectionOptions,
  TrackedFile,
  RepoRecord,
  SnapshotRecord,
  VectorResult,
  QueryOptions,
  CommitQueryOptions,
  UpsertChunk,
  UploadEvent,
} from '../types';

export class PgVectorStorage implements StorageBackend {
  private pool: Pool;
  private registered = false;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Register pgvector types on new connections */
  private async ensureRegistered(client: PoolClient): Promise<void> {
    if (!this.registered) {
      await pgvector.registerTypes(client);
      this.registered = true;
      // Also register for future connections from the pool
      this.pool.on('connect', async (c) => {
        await pgvector.registerTypes(c);
      });
    }
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await this.ensureRegistered(client);
      return await fn(client);
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Collection CRUD
  // ---------------------------------------------------------------------------

  async createCollection(opts: CreateCollectionOptions): Promise<CollectionRecord> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `INSERT INTO kvec.collections (name, description, embedding_model, dimensions, store_type)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [opts.name, opts.description ?? null, opts.embeddingModel, opts.dimensions, opts.storeType ?? 'mixed']
      );
      return this.mapCollectionRow(result.rows[0]);
    });
  }

  async getCollection(name: string): Promise<CollectionRecord | null> {
    return this.withClient(async (client) => {
      const result = await client.query(
        'SELECT * FROM kvec.collections WHERE name = $1',
        [name]
      );
      return result.rows.length > 0 ? this.mapCollectionRow(result.rows[0]) : null;
    });
  }

  async listCollections(): Promise<CollectionRecord[]> {
    return this.withClient(async (client) => {
      const result = await client.query(
        'SELECT * FROM kvec.collections ORDER BY created_at'
      );
      return result.rows.map(this.mapCollectionRow);
    });
  }

  async deleteCollection(name: string): Promise<void> {
    return this.withClient(async (client) => {
      await client.query('DELETE FROM kvec.collections WHERE name = $1', [name]);
    });
  }

  private mapCollectionRow(row: any): CollectionRecord {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      embeddingModel: row.embedding_model,
      dimensions: row.dimensions,
      storeType: row.store_type,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Chunk Operations
  // ---------------------------------------------------------------------------

  async upsertChunks(collectionId: string, fileId: string, chunks: UpsertChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    return this.withClient(async (client) => {
      // Delete existing chunks for this file, then insert new ones
      await client.query('BEGIN');
      try {
        await client.query('DELETE FROM kvec.chunks WHERE file_id = $1', [fileId]);

        for (const chunk of chunks) {
          await client.query(
            `INSERT INTO kvec.chunks (file_id, chunk_index, content, embedding, token_count, chunk_method, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              fileId,
              chunk.chunkIndex,
              chunk.content,
              pgvector.toSql(chunk.embedding),
              chunk.tokenCount,
              chunk.chunkMethod,
              chunk.metadata ? JSON.stringify(chunk.metadata) : null,
            ]
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
  }

  async deleteChunksByFileId(fileId: string): Promise<void> {
    return this.withClient(async (client) => {
      await client.query('DELETE FROM kvec.chunks WHERE file_id = $1', [fileId]);
    });
  }

  async query(collectionId: string, embedding: number[], opts?: QueryOptions): Promise<VectorResult[]> {
    return this.withClient(async (client) => {
      const limit = opts?.limit ?? 10;
      const conditions: string[] = ['f.collection_id = $2'];
      const params: any[] = [pgvector.toSql(embedding), collectionId];
      let paramIndex = 3;

      if (opts?.repoName) {
        conditions.push(`r.name = $${paramIndex}`);
        params.push(opts.repoName);
        paramIndex++;
      }

      if (opts?.language) {
        conditions.push(`f.language = $${paramIndex}`);
        params.push(opts.language);
        paramIndex++;
      }

      if (opts?.branch) {
        conditions.push(`s.branch = $${paramIndex}`);
        params.push(opts.branch);
        paramIndex++;
      }

      if (opts?.commitHash) {
        conditions.push(`s.commit_hash = $${paramIndex}`);
        params.push(opts.commitHash);
        paramIndex++;
      }

      if (opts?.filter && Object.keys(opts.filter).length > 0) {
        conditions.push(`c.metadata @> $${paramIndex}::jsonb`);
        params.push(JSON.stringify(opts.filter));
        paramIndex++;
      }

      if (opts?.since) {
        conditions.push(`f.updated_at >= $${paramIndex}::timestamptz`);
        params.push(opts.since);
        paramIndex++;
      }

      if (opts?.until) {
        conditions.push(`f.updated_at <= $${paramIndex}::timestamptz`);
        params.push(opts.until);
        paramIndex++;
      }

      const needsSnapshot = !!(opts?.branch || opts?.commitHash);

      // When no branch/commit filter, only search the latest version of each file
      // to avoid returning chunks from superseded versions.
      if (!needsSnapshot) {
        conditions.push(`NOT EXISTS (
          SELECT 1 FROM kvec.tracked_files f2
          WHERE f2.collection_id = f.collection_id
            AND f2.file_path = f.file_path
            AND f2.repo_id IS NOT DISTINCT FROM f.repo_id
            AND f2.updated_at > f.updated_at
        )`);
      }

      const whereClause = conditions.join(' AND ');

      // Cosine distance: <=> returns distance (0 = identical), convert to similarity
      const result = await client.query(
        `SELECT
           c.id,
           c.file_id,
           c.content,
           c.chunk_index,
           c.metadata,
           f.file_path,
           f.language,
           1 - (c.embedding <=> $1) AS score
         FROM kvec.chunks c
         JOIN kvec.tracked_files f ON f.id = c.file_id
         LEFT JOIN kvec.repos r ON r.id = f.repo_id
         ${needsSnapshot ? 'LEFT JOIN kvec.snapshot_files sf ON sf.file_id = f.id LEFT JOIN kvec.snapshots s ON s.id = sf.snapshot_id' : ''}
         WHERE ${whereClause}
         ORDER BY c.embedding <=> $1
         LIMIT $${paramIndex}`,
        [...params, limit]
      );

      const minScore = opts?.minScore ?? 0;
      return result.rows
        .filter((row: any) => row.score >= minScore)
        .map((row: any): VectorResult => ({
          id: row.id,
          fileId: row.file_id,
          content: row.content,
          score: parseFloat(row.score),
          chunkIndex: row.chunk_index,
          metadata: row.metadata,
          filePath: row.file_path,
          language: row.language,
        }));
    });
  }

  async queryCommits(collectionId: string, embedding: number[], opts?: CommitQueryOptions): Promise<VectorResult[]> {
    return this.withClient(async (client) => {
      const limit = opts?.limit ?? 20;
      const conditions: string[] = ['f.collection_id = $2'];
      const params: any[] = [pgvector.toSql(embedding), collectionId];
      let paramIndex = 3;

      if (opts?.repo) {
        conditions.push(`f.metadata->>'repo' = $${paramIndex}`);
        params.push(opts.repo);
        paramIndex++;
      }

      if (opts?.author) {
        conditions.push(`f.metadata->>'author' ILIKE $${paramIndex}`);
        params.push(`%${opts.author}%`);
        paramIndex++;
      }

      if (opts?.branch) {
        conditions.push(`f.metadata->>'branch' = $${paramIndex}`);
        params.push(opts.branch);
        paramIndex++;
      }

      if (opts?.since) {
        conditions.push(`(f.metadata->>'date')::timestamptz >= $${paramIndex}::timestamptz`);
        params.push(opts.since);
        paramIndex++;
      }

      if (opts?.until) {
        conditions.push(`(f.metadata->>'date')::timestamptz <= $${paramIndex}::timestamptz`);
        params.push(opts.until);
        paramIndex++;
      }

      const whereClause = conditions.join(' AND ');

      // Deduplicate by SHA: inner query picks best chunk per commit,
      // outer query sorts by score and applies limit.
      const result = await client.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (f.metadata->>'sha')
             c.id,
             c.file_id,
             c.content,
             c.chunk_index,
             f.file_path,
             f.language,
             f.metadata,
             1 - (c.embedding <=> $1) AS score
           FROM kvec.chunks c
           JOIN kvec.tracked_files f ON f.id = c.file_id
           WHERE ${whereClause}
           ORDER BY f.metadata->>'sha', c.embedding <=> $1
         ) deduped
         ORDER BY score DESC
         LIMIT $${paramIndex}`,
        [...params, limit]
      );

      const minScore = opts?.minScore ?? 0;
      return result.rows
        .filter((row: any) => row.score >= minScore)
        .map((row: any): VectorResult => ({
          id: row.id,
          fileId: row.file_id,
          content: row.content,
          score: parseFloat(row.score),
          chunkIndex: row.chunk_index,
          metadata: row.metadata,
          filePath: row.file_path,
          language: row.language,
        }));
    });
  }

  async count(collectionId: string): Promise<number> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT COUNT(*) AS cnt
         FROM kvec.chunks c
         JOIN kvec.tracked_files f ON f.id = c.file_id
         WHERE f.collection_id = $1`,
        [collectionId]
      );
      return parseInt(result.rows[0].cnt, 10);
    });
  }

  async hasChunksForFile(fileId: string): Promise<boolean> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT 1
         FROM kvec.chunks
         WHERE file_id = $1
         LIMIT 1`,
        [fileId]
      );
      return result.rows.length > 0;
    });
  }

  // ---------------------------------------------------------------------------
  // File Tracking
  // ---------------------------------------------------------------------------

  async findTrackedFile(collectionId: string, filePath: string, repoId?: string, contentHash?: string): Promise<TrackedFile | null> {
    return this.withClient(async (client) => {
      let result;
      if (repoId && contentHash) {
        result = await client.query(
          `SELECT * FROM kvec.tracked_files
           WHERE collection_id = $1 AND file_path = $2 AND repo_id = $3 AND content_hash = $4
           LIMIT 1`,
          [collectionId, filePath, repoId, contentHash]
        );
      } else if (repoId) {
        result = await client.query(
          `SELECT * FROM kvec.tracked_files
           WHERE collection_id = $1 AND file_path = $2 AND repo_id = $3
           ORDER BY updated_at DESC LIMIT 1`,
          [collectionId, filePath, repoId]
        );
      } else {
        result = await client.query(
          `SELECT * FROM kvec.tracked_files
           WHERE collection_id = $1 AND file_path = $2 AND repo_id IS NULL
           ORDER BY updated_at DESC LIMIT 1`,
          [collectionId, filePath]
        );
      }
      return result.rows.length > 0 ? this.mapTrackedFileRow(result.rows[0]) : null;
    });
  }

  async upsertTrackedFile(file: Omit<TrackedFile, 'id' | 'uploadedAt' | 'updatedAt'>): Promise<TrackedFile> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `INSERT INTO kvec.tracked_files
           (collection_id, repo_id, file_path, content_hash, file_size, language, status, error_message, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (collection_id, repo_id, file_path, content_hash)
         DO UPDATE SET
           file_size = EXCLUDED.file_size,
           language = EXCLUDED.language,
           status = EXCLUDED.status,
           error_message = EXCLUDED.error_message,
           metadata = EXCLUDED.metadata,
           updated_at = now()
         RETURNING *`,
        [
          file.collectionId,
          file.repoId,
          file.filePath,
          file.contentHash,
          file.fileSize,
          file.language,
          file.status,
          file.errorMessage,
          file.metadata ? JSON.stringify(file.metadata) : null,
        ]
      );
      return this.mapTrackedFileRow(result.rows[0]);
    });
  }

  async deleteTrackedFile(fileId: string): Promise<void> {
    return this.withClient(async (client) => {
      // Chunks cascade-delete via FK
      await client.query('DELETE FROM kvec.tracked_files WHERE id = $1', [fileId]);
    });
  }

  private mapTrackedFileRow(row: any): TrackedFile {
    return {
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
    };
  }

  // ---------------------------------------------------------------------------
  // Repo & Snapshot Management
  // ---------------------------------------------------------------------------

  async findOrCreateRepo(collectionId: string, name: string, rootPath: string, remoteUrl?: string): Promise<RepoRecord> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `INSERT INTO kvec.repos (collection_id, name, root_path, remote_url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (collection_id, name)
         DO UPDATE SET
           root_path = EXCLUDED.root_path,
           remote_url = COALESCE(EXCLUDED.remote_url, kvec.repos.remote_url),
           updated_at = now()
         RETURNING *`,
        [collectionId, name, rootPath, remoteUrl ?? null]
      );
      return this.mapRepoRow(result.rows[0]);
    });
  }

  async findOrCreateSnapshot(repoId: string, branch: string, commitHash: string): Promise<SnapshotRecord> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `INSERT INTO kvec.snapshots (repo_id, branch, commit_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (repo_id, branch, commit_hash)
         DO NOTHING
         RETURNING *`,
        [repoId, branch, commitHash]
      );

      if (result.rows.length > 0) {
        return this.mapSnapshotRow(result.rows[0]);
      }

      // Already existed, fetch it
      const existing = await client.query(
        'SELECT * FROM kvec.snapshots WHERE repo_id = $1 AND branch = $2 AND commit_hash = $3',
        [repoId, branch, commitHash]
      );
      return this.mapSnapshotRow(existing.rows[0]);
    });
  }

  async linkSnapshot(snapshotId: string, fileId: string): Promise<void> {
    return this.withClient(async (client) => {
      await client.query(
        `INSERT INTO kvec.snapshot_files (snapshot_id, file_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [snapshotId, fileId]
      );
    });
  }

  private mapRepoRow(row: any): RepoRecord {
    return {
      id: row.id,
      collectionId: row.collection_id,
      name: row.name,
      rootPath: row.root_path,
      remoteUrl: row.remote_url,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapSnapshotRow(row: any): SnapshotRecord {
    return {
      id: row.id,
      repoId: row.repo_id,
      branch: row.branch,
      commitHash: row.commit_hash,
      createdAt: row.created_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Upload Events
  // ---------------------------------------------------------------------------

  async logUploadEvent(event: UploadEvent): Promise<void> {
    return this.withClient(async (client) => {
      await client.query(
        `INSERT INTO kvec.upload_events
           (collection_id, snapshot_id, event_type, source_path,
            files_processed, files_skipped, files_errored,
            chunks_created, chunks_deleted, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          event.collectionId,
          event.snapshotId ?? null,
          event.eventType,
          event.sourcePath ?? null,
          event.filesProcessed,
          event.filesSkipped,
          event.filesErrored,
          event.chunksCreated,
          event.chunksDeleted,
          event.durationMs ?? null,
        ]
      );
    });
  }
}
