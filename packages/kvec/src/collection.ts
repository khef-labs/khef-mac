import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import path from 'path';
import {
  CollectionRecord,
  StorageBackend,
  EmbeddingProvider,
  VectorResult,
  QueryOptions,
  CommitQueryOptions,
  UpsertChunk,
  ChunkResult,
  Chunker,
  IngestContentOptions,
} from './types';

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

export interface IngestOptions {
  /** Repo name for git project tracking */
  repoName?: string;
  /** Repo root path */
  repoRootPath?: string;
  /** Git remote URL */
  remoteUrl?: string;
  /** Git branch */
  branch?: string;
  /** Git commit hash */
  commitHash?: string;
  /** File language override */
  language?: string;
  /** Additional metadata to attach to the tracked file */
  metadata?: Record<string, unknown>;
}

export class Collection {
  private record: CollectionRecord;
  /** @internal exposed for ingestDirectory to log upload events */
  readonly storage: StorageBackend;
  private embedder: EmbeddingProvider;
  private chunker: Chunker;

  constructor(
    record: CollectionRecord,
    storage: StorageBackend,
    embedder: EmbeddingProvider,
    chunker: Chunker
  ) {
    this.record = record;
    this.storage = storage;
    this.embedder = embedder;
    this.chunker = chunker;
  }

  get id(): string {
    return this.record.id;
  }

  get name(): string {
    return this.record.name;
  }

  get info(): CollectionRecord {
    return this.record;
  }

  /**
   * Upsert pre-chunked documents with embeddings.
   * If embeddings are not provided, they will be generated.
   */
  async upsert(fileId: string, chunks: UpsertChunk[]): Promise<void> {
    await this.storage.upsertChunks(this.record.id, fileId, chunks);
  }

  /**
   * Query by text — generates embedding, then searches.
   */
  async query(text: string, opts?: QueryOptions): Promise<VectorResult[]> {
    const [embedding] = await this.embedder.embed([text]);
    return this.storage.query(this.record.id, embedding, opts);
  }

  /**
   * Query with a pre-computed embedding vector.
   */
  async queryWithEmbedding(embedding: number[], opts?: QueryOptions): Promise<VectorResult[]> {
    return this.storage.query(this.record.id, embedding, opts);
  }

  /**
   * Query commits — metadata-based filtering (repo, author, date range).
   * Deduplicates by SHA, returning the highest-scoring chunk per commit.
   */
  async queryCommits(text: string, opts?: CommitQueryOptions): Promise<VectorResult[]> {
    const [embedding] = await this.embedder.embed([text]);
    return this.storage.queryCommits(this.record.id, embedding, opts);
  }

  /**
   * Query commits with a pre-computed embedding vector.
   */
  async queryCommitsWithEmbedding(embedding: number[], opts?: CommitQueryOptions): Promise<VectorResult[]> {
    return this.storage.queryCommits(this.record.id, embedding, opts);
  }

  /**
   * Generate embedding(s) for text(s) without querying.
   */
  async embed(texts: string[]): Promise<number[][]> {
    return this.embedder.embed(texts);
  }

  /**
   * Delete tracked file and its chunks by file ID.
   */
  async delete(fileId: string): Promise<void> {
    await this.storage.deleteTrackedFile(fileId);
  }

  /**
   * Get total chunk count in this collection.
   */
  async count(): Promise<number> {
    return this.storage.count(this.record.id);
  }

  /**
   * High-level ingest: read a file, chunk it, embed chunks, upsert with tracking.
   * Skips if file content hash hasn't changed.
   *
   * Returns the number of chunks created (0 if skipped).
   */
  async ingest(filePath: string, opts?: IngestOptions): Promise<number> {
    const absolutePath = path.resolve(filePath);
    if (BINARY_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) {
      return 0;
    }

    const stat = statSync(absolutePath);
    const content = readFileSync(absolutePath, 'utf-8');
    const contentHash = createHash('sha256').update(content).digest('hex');

    // Resolve repo and snapshot if git info provided
    let repoId: string | undefined;
    let snapshotId: string | undefined;

    if (opts?.repoName && opts.repoRootPath) {
      const repo = await this.storage.findOrCreateRepo(
        this.record.id,
        opts.repoName,
        opts.repoRootPath,
        opts.remoteUrl
      );
      repoId = repo.id;

      if (opts.branch && opts.commitHash) {
        const snapshot = await this.storage.findOrCreateSnapshot(
          repo.id,
          opts.branch,
          opts.commitHash
        );
        snapshotId = snapshot.id;
      }
    }

    // Compute relative path if repo root provided
    const trackPath = opts?.repoRootPath
      ? path.relative(opts.repoRootPath, absolutePath)
      : absolutePath;

    // Check if this exact file content is already tracked (content-addressable)
    const existing = await this.storage.findTrackedFile(
      this.record.id,
      trackPath,
      repoId,
      contentHash
    );

    if (existing) {
      const hasChunks = await this.storage.hasChunksForFile(existing.id);
      if (hasChunks) {
        // Same content already exists with chunk rows — just link this snapshot
        if (snapshotId) {
          await this.storage.linkSnapshot(snapshotId, existing.id);
        }
        return 0; // unchanged, skip
      }
      // Corrupt/incomplete tracked file (no chunks): continue and reindex content.
    }

    // Hint file path to chunker (used by AST chunker for language detection)
    if ('setFilePath' in this.chunker && typeof (this.chunker as any).setFilePath === 'function') {
      (this.chunker as any).setFilePath(absolutePath);
    }

    // Chunk the content
    const chunkResults = this.chunker.chunk(content, {
      modelName: this.record.embeddingModel,
    });

    if (chunkResults.length === 0) return 0;

    // Generate embeddings in batches to avoid OOM on large files
    const texts = chunkResults.map((c) => c.content);
    const embeddings = await this.embedBatched(texts);

    // Upsert tracked file record
    const trackedFile = await this.storage.upsertTrackedFile({
      collectionId: this.record.id,
      repoId: repoId ?? null,
      filePath: trackPath,
      contentHash,
      fileSize: stat.size,
      language: opts?.language ?? detectLanguage(absolutePath),
      status: 'active',
      errorMessage: null,
      metadata: opts?.metadata ?? null,
    });

    // Link this snapshot to the file
    if (snapshotId) {
      await this.storage.linkSnapshot(snapshotId, trackedFile.id);
    }

    // Build chunk records
    const upsertChunks: UpsertChunk[] = chunkResults.map(
      (cr: ChunkResult, i: number) => ({
        chunkIndex: cr.index,
        content: cr.content,
        embedding: embeddings[i],
        tokenCount: cr.tokenCount,
        chunkMethod: cr.method,
        metadata: cr.metadata,
      })
    );

    await this.storage.upsertChunks(this.record.id, trackedFile.id, upsertChunks);
    return upsertChunks.length;
  }

  /**
   * Ingest raw text content (not a file on disk).
   * Uses documentId as a stable key in tracked_files (stored as file_path).
   * Skips if content hash hasn't changed.
   *
   * Returns the number of chunks created (0 if skipped).
   */
  async ingestContent(
    documentId: string,
    content: string,
    opts?: IngestContentOptions
  ): Promise<number> {
    const contentHash = createHash('sha256').update(content).digest('hex');

    // Check if already tracked (non-git content stays single-version)
    const existing = await this.storage.findTrackedFile(
      this.record.id,
      documentId
    );

    if (existing && existing.contentHash === contentHash) {
      const hasChunks = await this.storage.hasChunksForFile(existing.id);
      if (hasChunks) {
        return 0; // unchanged, skip
      }
      // Corrupt/incomplete tracked file (no chunks): continue and reindex content.
    }

    // Delete old version before inserting new (non-git files are single-version)
    if (existing) {
      await this.storage.deleteTrackedFile(existing.id);
    }

    // Chunk the content
    const chunkResults = this.chunker.chunk(content, {
      modelName: this.record.embeddingModel,
    });

    if (chunkResults.length === 0) return 0;

    // Generate embeddings in batches to avoid OOM on large files
    const texts = chunkResults.map((c) => c.content);
    const embeddings = await this.embedBatched(texts);

    // Merge metadata into each chunk if provided
    const chunkMeta = opts?.metadata ?? undefined;

    // Upsert tracked file record
    const trackedFile = await this.storage.upsertTrackedFile({
      collectionId: this.record.id,
      repoId: null,
      filePath: documentId,
      contentHash,
      fileSize: Buffer.byteLength(content, 'utf-8'),
      language: opts?.language ?? null,
      status: 'active',
      errorMessage: null,
      metadata: opts?.metadata ?? null,
    });

    // Build chunk records
    const upsertChunks: UpsertChunk[] = chunkResults.map(
      (cr: ChunkResult, i: number) => ({
        chunkIndex: cr.index,
        content: cr.content,
        embedding: embeddings[i],
        tokenCount: cr.tokenCount,
        chunkMethod: cr.method,
        metadata: { ...cr.metadata, ...chunkMeta },
      })
    );

    await this.storage.upsertChunks(this.record.id, trackedFile.id, upsertChunks);
    return upsertChunks.length;
  }

  /**
   * Embed texts in batches to avoid OOM on large documents.
   * Returns a flat array of embeddings matching the input order.
   */
  private async embedBatched(texts: string[], batchSize = 100): Promise<number[][]> {
    if (texts.length <= batchSize) {
      return this.embedder.embed(texts);
    }
    const embeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchEmbeddings = await this.embedder.embed(batch);
      embeddings.push(...batchEmbeddings);
    }
    return embeddings;
  }

  /**
   * Delete a document and all its chunks by document ID.
   * The documentId matches the file_path used in ingestContent().
   */
  async deleteDocument(documentId: string): Promise<boolean> {
    const existing = await this.storage.findTrackedFile(
      this.record.id,
      documentId
    );

    if (!existing) return false;

    await this.storage.deleteTrackedFile(existing.id);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LANGUAGE_MAP: Record<string, string> = {
  '.py': 'python',
  '.java': 'java',
  '.js': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.jsx': 'javascript',
  '.cs': 'csharp',
  '.go': 'go',
  '.rs': 'rust',
  '.cpp': 'cpp',
  '.c': 'c',
  '.php': 'php',
  '.rb': 'ruby',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.swift': 'swift',
  '.md': 'markdown',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.html': 'html',
  '.css': 'css',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
};

function detectLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_MAP[ext] ?? null;
}
