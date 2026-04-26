/**
 * Ingest kvec source code and keep the data for inspection.
 *
 * Usage:
 *   cd packages/kvec
 *   npx tsx ingest-kvec-src.ts
 */

import { readFileSync } from 'fs';
import { Pool } from 'pg';
import path from 'path';

const envPath = path.join(__dirname, '../../apps/api/.env');
const envContent = readFileSync(envPath, 'utf-8');
const envVars: Record<string, string> = {};
for (const line of envContent.split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const eqIdx = line.indexOf('=');
  if (eqIdx === -1) continue;
  const key = line.slice(0, eqIdx).trim();
  let val = line.slice(eqIdx + 1).trim();
  val = val.replace(/\$\{(\w+)\}/g, (_, k) => envVars[k] ?? process.env[k] ?? '');
  envVars[key] = val;
}
Object.assign(process.env, envVars);

import { KVec } from './src/index';
import { ingestDirectory } from './src/ingest';

const COLLECTION_NAME = 'kvec-source';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const kvec = new KVec({
    pool,
    embedding: {
      provider: 'python-sidecar',
      serverUrl: 'http://127.0.0.1:9100',
      model: 'all-mpnet-base-v2',
    },
  });

  try {
    // Create or get collection
    let coll = await kvec.collection(COLLECTION_NAME);
    if (!coll) {
      coll = await kvec.createCollection({
        name: COLLECTION_NAME,
        description: 'kvec source code for inspection',
        embeddingModel: 'all-mpnet-base-v2',
        dimensions: 768,
        storeType: 'source-code',
      });
      console.log(`Created collection: ${coll.name}`);
    } else {
      console.log(`Using existing collection: ${coll.name}`);
    }

    const srcDir = path.join(__dirname, 'src');
    console.log(`\nIngesting: ${srcDir}\n`);

    const result = await ingestDirectory(coll, srcDir, {
      extensions: ['.ts'],
      verbose: true,
    });

    console.log(`\nTotal chunks: ${await coll.count()}`);
    console.log('Data preserved — check DBeaver: kvec.collections, kvec.tracked_files, kvec.chunks');
  } finally {
    await pool.end();
  }
}

main();
