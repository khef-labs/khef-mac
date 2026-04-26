/**
 * Singleton kvec instance for the khef API.
 * Provides lazily-initialized collections for memory and session embeddings.
 */

import path from 'path';
import pool from '../db/client';
import { KVec, Collection } from '@khef/kvec';

const EMBEDDING_MODEL = 'all-mpnet-base-v2';
const DIMENSIONS = 768;
const EMBED_SCRIPT = path.join(__dirname, 'vector', 'embed.py');
const EMBED_SERVER_URL = process.env.EMBED_SERVER_URL || 'http://127.0.0.1:9100';

let kvecInstance: KVec | null = null;
let memoriesCollection: Collection | null = null;
let sessionsCollection: Collection | null = null;
let sourceCollection: Collection | null = null;
let commitsCollection: Collection | null = null;
let slackCollection: Collection | null = null;
let docsCollection: Collection | null = null;

export function getKvec(): KVec {
  if (!kvecInstance) {
    kvecInstance = new KVec({
      pool,
      embedding: {
        provider: 'python-sidecar',
        serverUrl: EMBED_SERVER_URL,
        scriptPath: EMBED_SCRIPT,
        model: EMBEDDING_MODEL,
      },
    });
  }
  return kvecInstance;
}

/**
 * Get or create the khef-memories collection.
 */
export async function getMemoriesCollection(): Promise<Collection> {
  if (memoriesCollection) return memoriesCollection;

  const kvec = getKvec();
  let coll = await kvec.collection('khef-memories');
  if (!coll) {
    coll = await kvec.createCollection({
      name: 'khef-memories',
      description: 'Khef memory embeddings',
      embeddingModel: EMBEDDING_MODEL,
      dimensions: DIMENSIONS,
      storeType: 'mixed',
    });
  }
  memoriesCollection = coll;
  return coll;
}

/**
 * Get or create the khef-sessions collection.
 */
export async function getSessionsCollection(): Promise<Collection> {
  if (sessionsCollection) return sessionsCollection;

  const kvec = getKvec();
  let coll = await kvec.collection('khef-sessions');
  if (!coll) {
    coll = await kvec.createCollection({
      name: 'khef-sessions',
      description: 'Khef session transcript embeddings',
      embeddingModel: EMBEDDING_MODEL,
      dimensions: DIMENSIONS,
      storeType: 'mixed',
    });
  }
  sessionsCollection = coll;
  return coll;
}

/**
 * Get the kvec-source collection (indexed by external ingest script).
 * Returns null if the collection doesn't exist — it's not auto-created.
 */
export async function getSourceCollection(): Promise<Collection | null> {
  if (sourceCollection) return sourceCollection;

  const kvec = getKvec();
  const coll = await kvec.collection('kvec-source');
  if (!coll) return null;
  sourceCollection = coll;
  return coll;
}

/**
 * Get or create the kvec-source collection for source code embeddings.
 */
export async function getOrCreateSourceCollection(): Promise<Collection> {
  if (sourceCollection) return sourceCollection;

  const kvec = getKvec();
  let coll = await kvec.collection('kvec-source');
  if (!coll) {
    coll = await kvec.createCollection({
      name: 'kvec-source',
      description: 'Embedded source code',
      embeddingModel: EMBEDDING_MODEL,
      dimensions: DIMENSIONS,
      storeType: 'source-code',
    });
  }
  sourceCollection = coll;
  return coll;
}

/**
 * Get the kvec-commits collection (indexed by commit embed jobs).
 * Returns null if the collection doesn't exist.
 */
export async function getCommitsCollection(): Promise<Collection | null> {
  if (commitsCollection) return commitsCollection;

  const kvec = getKvec();
  const coll = await kvec.collection('kvec-commits');
  if (!coll) return null;
  commitsCollection = coll;
  return coll;
}

/**
 * Get or create the kvec-commits collection for commit message embeddings.
 */
export async function getOrCreateCommitsCollection(): Promise<Collection> {
  if (commitsCollection) return commitsCollection;

  const kvec = getKvec();
  let coll = await kvec.collection('kvec-commits');
  if (!coll) {
    coll = await kvec.createCollection({
      name: 'kvec-commits',
      description: 'Git commit message embeddings',
      embeddingModel: EMBEDDING_MODEL,
      dimensions: DIMENSIONS,
      storeType: 'mixed',
    });
  }
  commitsCollection = coll;
  return coll;
}

/**
 * Get or create the slack-messages collection.
 * Uses markdown storeType for heading-aware chunking (splits at ### message headers).
 */
export async function getOrCreateSlackCollection(): Promise<Collection> {
  if (slackCollection) return slackCollection;

  const kvec = getKvec();
  let coll = await kvec.collection('slack-messages');
  if (!coll) {
    coll = await kvec.createCollection({
      name: 'slack-messages',
      description: 'Ingested Slack message history',
      embeddingModel: EMBEDDING_MODEL,
      dimensions: DIMENSIONS,
      storeType: 'markdown',
    });
  }
  slackCollection = coll;
  return coll;
}

/**
 * Get or create the kvec-docs collection for document embeddings.
 * Uses markdown storeType for heading-aware chunking.
 */
export async function getOrCreateDocsCollection(): Promise<Collection> {
  if (docsCollection) return docsCollection;

  const kvec = getKvec();
  let coll = await kvec.collection('kvec-docs');
  if (!coll) {
    coll = await kvec.createCollection({
      name: 'kvec-docs',
      description: 'Embedded documents (markdown, PDF, text)',
      embeddingModel: EMBEDDING_MODEL,
      dimensions: DIMENSIONS,
      storeType: 'markdown',
    });
  }
  docsCollection = coll;
  return coll;
}

/**
 * Ensure default kvec collections exist for API/UI visibility.
 */
export async function ensureDefaultCollections(): Promise<Collection[]> {
  const [memories, sessions, source, commits, slack, docs] = await Promise.all([
    getMemoriesCollection(),
    getSessionsCollection(),
    getOrCreateSourceCollection(),
    getOrCreateCommitsCollection(),
    getOrCreateSlackCollection(),
    getOrCreateDocsCollection(),
  ]);
  return [memories, sessions, source, commits, slack, docs];
}

/** Get the embed server URL for health checks */
export function getEmbedServerUrl(): string {
  return EMBED_SERVER_URL;
}
