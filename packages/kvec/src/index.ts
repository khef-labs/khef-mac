import { Pool } from 'pg';
import {
  KVecConfig,
  CollectionRecord,
  CreateCollectionOptions,
  EmbeddingProvider,
  Chunker,
} from './types';
import { PgVectorStorage } from './storage/pgvector';
import { PythonSidecarProvider } from './embeddings/python-sidecar';
import { TokenAwareChunker } from './chunking/token-aware';
import { MarkdownChunker } from './chunking/markdown';
import { ASTSidecarChunker } from './chunking/ast-sidecar';
import { Collection } from './collection';

// Re-export types for consumers
export type {
  KVecConfig,
  EmbeddingConfig,
  CollectionRecord,
  CreateCollectionOptions,
  VectorDocument,
  VectorChunk,
  VectorResult,
  QueryOptions,
  CommitQueryOptions,
  TrackedFile,
  RepoRecord,
  SnapshotRecord,
  StorageBackend,
  EmbeddingProvider,
  Chunker,
  ChunkerOptions,
  ChunkResult,
  UpsertChunk,
  UploadEvent,
  IngestContentOptions,
} from './types';

// Re-export implementations
export { PgVectorStorage } from './storage/pgvector';
export { PythonSidecarProvider } from './embeddings/python-sidecar';
export { TokenAwareChunker, estimateTokenCount, getCharPerTokenRatio } from './chunking/token-aware';
export { MarkdownChunker } from './chunking/markdown';
export { ASTSidecarChunker } from './chunking/ast-sidecar';
export { Collection } from './collection';
export type { IngestOptions } from './collection';
export { ingestDirectory, ingestCommits } from './ingest';
export type { IngestDirectoryOptions, IngestCommitsOptions, IngestResult } from './ingest';

/**
 * KVec — lightweight embeddable vector database using pgvector.
 *
 * Usage:
 *   const kvec = new KVec({ pool, embedding: { provider: 'python-sidecar' } });
 *   const coll = await kvec.createCollection({ name: 'docs', embeddingModel: 'all-mpnet-base-v2', dimensions: 768 });
 *   await coll.ingest('/path/to/file.md');
 *   const results = await coll.query('search text');
 */
export class KVec {
  private pool: Pool;
  private storage: PgVectorStorage;
  private embedder: EmbeddingProvider;
  private chunkers: { tokenAware: TokenAwareChunker; markdown: MarkdownChunker; ast: ASTSidecarChunker };

  constructor(config: KVecConfig) {
    this.pool = config.pool;
    this.storage = new PgVectorStorage(config.pool);

    // Set up embedding provider
    if (config.embedding.provider === 'custom' && config.embedding.embedFn) {
      this.embedder = {
        embed: config.embedding.embedFn,
        dimensions: () => 768,
        model: () => 'custom',
      };
    } else {
      this.embedder = new PythonSidecarProvider(config.embedding);
    }

    const serverUrl = config.embedding.serverUrl ?? 'http://127.0.0.1:9100';
    this.chunkers = {
      tokenAware: new TokenAwareChunker(),
      markdown: new MarkdownChunker(),
      ast: new ASTSidecarChunker(serverUrl),
    };
  }

  /**
   * Create a new collection.
   */
  async createCollection(opts: CreateCollectionOptions): Promise<Collection> {
    const record = await this.storage.createCollection(opts);
    return this.wrapCollection(record);
  }

  /**
   * Get an existing collection by name.
   * Returns null if not found.
   */
  async collection(name: string): Promise<Collection | null> {
    const record = await this.storage.getCollection(name);
    if (!record) return null;
    return this.wrapCollection(record);
  }

  /**
   * Get an existing collection or throw if not found.
   */
  async collectionOrThrow(name: string): Promise<Collection> {
    const coll = await this.collection(name);
    if (!coll) throw new Error(`Collection '${name}' not found`);
    return coll;
  }

  /**
   * List all collections.
   */
  async listCollections(): Promise<CollectionRecord[]> {
    return this.storage.listCollections();
  }

  /**
   * Delete a collection by name (cascades to all data).
   */
  async deleteCollection(name: string): Promise<void> {
    await this.storage.deleteCollection(name);
  }

  /** Get the underlying storage backend for advanced use */
  getStorage(): PgVectorStorage {
    return this.storage;
  }

  /** Get the embedding provider */
  getEmbedder(): EmbeddingProvider {
    return this.embedder;
  }

  private wrapCollection(record: CollectionRecord): Collection {
    // Choose chunker based on store type
    let chunker: Chunker;
    switch (record.storeType) {
      case 'markdown':
        chunker = this.chunkers.markdown;
        break;
      case 'source-code':
        chunker = this.chunkers.ast;
        break;
      default:
        chunker = this.chunkers.tokenAware;
        break;
    }
    return new Collection(record, this.storage, this.embedder, chunker);
  }
}
