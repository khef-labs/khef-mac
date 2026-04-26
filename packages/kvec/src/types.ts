import { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface KVecConfig {
  /** Existing pg Pool to share with the host application */
  pool: Pool;
  /** Embedding provider configuration */
  embedding: EmbeddingConfig;
}

export interface EmbeddingConfig {
  /** Provider type */
  provider: 'python-sidecar' | 'ollama' | 'custom';
  /** Embed server URL (python-sidecar) */
  serverUrl?: string;
  /** Path to embed.py fallback script */
  scriptPath?: string;
  /** Model name for the provider */
  model?: string;
  /** Ollama base URL */
  ollamaUrl?: string;
  /** Custom embedding function (for 'custom' provider) */
  embedFn?: (texts: string[]) => Promise<number[][]>;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export interface CollectionRecord {
  id: string;
  name: string;
  description: string | null;
  embeddingModel: string;
  dimensions: number;
  storeType: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCollectionOptions {
  name: string;
  description?: string;
  embeddingModel: string;
  dimensions: number;
  storeType?: string;
}

// ---------------------------------------------------------------------------
// Documents & Results
// ---------------------------------------------------------------------------

export interface VectorDocument {
  /** Unique identifier */
  id?: string;
  /** Text content */
  content: string;
  /** Pre-computed embedding (if not provided, will be generated) */
  embedding?: number[];
  /** Arbitrary metadata stored as JSONB */
  metadata?: Record<string, unknown>;
}

export interface VectorChunk {
  id: string;
  fileId: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
  tokenCount: number;
  chunkMethod: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface VectorResult {
  /** Chunk ID */
  id: string;
  /** File ID the chunk belongs to */
  fileId: string;
  /** Chunk content */
  content: string;
  /** Cosine similarity score (0-1, higher = more similar) */
  score: number;
  /** Chunk index within the file */
  chunkIndex: number;
  /** Chunk metadata */
  metadata: Record<string, unknown> | null;
  /** File path (from tracked_files) */
  filePath: string;
  /** Programming language (from tracked_files) */
  language: string | null;
}

export interface QueryOptions {
  /** Max results to return (default: 10) */
  limit?: number;
  /** Filter by repo name */
  repoName?: string;
  /** Filter by file language */
  language?: string;
  /** Filter by snapshot branch */
  branch?: string;
  /** Filter by snapshot commit hash */
  commitHash?: string;
  /** Minimum similarity score threshold (0-1) */
  minScore?: number;
  /** Filter on chunk or tracked_file metadata (JSONB containment) */
  filter?: Record<string, unknown>;
  /** Only include files updated after this date (ISO 8601) */
  since?: string;
  /** Only include files updated before this date (ISO 8601) */
  until?: string;
}

export interface CommitQueryOptions {
  /** Max results to return (default: 20) */
  limit?: number;
  /** Filter by repo name (matches metadata.repo) */
  repo?: string;
  /** Filter by author name (case-insensitive partial match) */
  author?: string;
  /** Filter by branch name (matches metadata.branch) */
  branch?: string;
  /** Only include commits after this date (ISO 8601) */
  since?: string;
  /** Only include commits before this date (ISO 8601) */
  until?: string;
  /** Minimum similarity score threshold (0-1) */
  minScore?: number;
}

// ---------------------------------------------------------------------------
// Content Ingestion (non-file documents)
// ---------------------------------------------------------------------------

export interface IngestContentOptions {
  /** Language label (e.g., 'markdown', 'text') */
  language?: string;
  /** Additional metadata stored on tracked_file and propagated to chunks */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// File Tracking
// ---------------------------------------------------------------------------

export interface TrackedFile {
  id: string;
  collectionId: string;
  repoId: string | null;
  filePath: string;
  contentHash: string;
  fileSize: number;
  language: string | null;
  status: 'active' | 'error' | 'pending';
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
  uploadedAt: Date;
  updatedAt: Date;
}

export interface RepoRecord {
  id: string;
  collectionId: string;
  name: string;
  rootPath: string;
  remoteUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SnapshotRecord {
  id: string;
  repoId: string;
  branch: string;
  commitHash: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Storage Backend Interface
// ---------------------------------------------------------------------------

export interface StorageBackend {
  // Collection CRUD
  createCollection(opts: CreateCollectionOptions): Promise<CollectionRecord>;
  getCollection(name: string): Promise<CollectionRecord | null>;
  listCollections(): Promise<CollectionRecord[]>;
  deleteCollection(name: string): Promise<void>;

  // Chunk operations
  upsertChunks(collectionId: string, fileId: string, chunks: UpsertChunk[]): Promise<void>;
  deleteChunksByFileId(fileId: string): Promise<void>;
  query(collectionId: string, embedding: number[], opts?: QueryOptions): Promise<VectorResult[]>;
  queryCommits(collectionId: string, embedding: number[], opts?: CommitQueryOptions): Promise<VectorResult[]>;
  count(collectionId: string): Promise<number>;
  hasChunksForFile(fileId: string): Promise<boolean>;

  // File tracking
  findTrackedFile(collectionId: string, filePath: string, repoId?: string, contentHash?: string): Promise<TrackedFile | null>;
  upsertTrackedFile(file: Omit<TrackedFile, 'id' | 'uploadedAt' | 'updatedAt'>): Promise<TrackedFile>;
  deleteTrackedFile(fileId: string): Promise<void>;

  // Repo & snapshot management
  findOrCreateRepo(collectionId: string, name: string, rootPath: string, remoteUrl?: string): Promise<RepoRecord>;
  findOrCreateSnapshot(repoId: string, branch: string, commitHash: string): Promise<SnapshotRecord>;
  linkSnapshot(snapshotId: string, fileId: string): Promise<void>;

  // Upload events
  logUploadEvent(event: UploadEvent): Promise<void>;
}

export interface UpsertChunk {
  chunkIndex: number;
  content: string;
  embedding: number[];
  tokenCount: number;
  chunkMethod: string;
  metadata?: Record<string, unknown>;
}

export interface UploadEvent {
  collectionId: string;
  snapshotId?: string;
  eventType: 'upload' | 'reindex' | 'delete' | 'prune';
  sourcePath?: string;
  filesProcessed: number;
  filesSkipped: number;
  filesErrored: number;
  chunksCreated: number;
  chunksDeleted: number;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Embedding Provider Interface
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  /** Generate embeddings for a batch of texts */
  embed(texts: string[]): Promise<number[][]>;
  /** Get the dimension of embeddings produced by this provider */
  dimensions(): number;
  /** Get the model name */
  model(): string;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export interface ChunkResult {
  /** Chunk text content */
  content: string;
  /** Chunk index (0-based) */
  index: number;
  /** Estimated token count */
  tokenCount: number;
  /** Method used to produce this chunk */
  method: string;
  /** Optional chunk-specific metadata (e.g. markdown headings) */
  metadata?: Record<string, unknown>;
}

export interface ChunkerOptions {
  /** Target chunk size in tokens */
  chunkSizeTokens?: number;
  /** Overlap between chunks in tokens */
  overlapTokens?: number;
  /** Model name for token estimation */
  modelName?: string;
}

export interface Chunker {
  /** Split text into chunks */
  chunk(text: string, options?: ChunkerOptions): ChunkResult[];
}
