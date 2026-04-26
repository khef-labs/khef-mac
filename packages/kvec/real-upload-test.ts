/**
 * kvec real upload test — ingests the kvec source code itself,
 * then queries to verify semantic search works on real files.
 *
 * Usage:
 *   cd packages/kvec
 *   npx tsx real-upload-test.ts
 */

import { readFileSync } from 'fs';
import { Pool } from 'pg';
import path from 'path';

// Load env from api's .env
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

const COLLECTION_NAME = '_kvec_real_upload_test';

async function main() {
  console.log('kvec real upload test');
  console.log('====================\n');

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
    // Clean up any prior test
    await kvec.deleteCollection(COLLECTION_NAME);

    // Create collection for source code
    const coll = await kvec.createCollection({
      name: COLLECTION_NAME,
      description: 'Real upload test — kvec source code',
      embeddingModel: 'all-mpnet-base-v2',
      dimensions: 768,
      storeType: 'source-code',
    });
    console.log(`Created collection: ${coll.name}\n`);

    // Ingest kvec's own source code
    const srcDir = path.join(__dirname, 'src');
    console.log(`Ingesting: ${srcDir}`);
    console.log('---');

    const result = await ingestDirectory(coll, srcDir, {
      extensions: ['.ts'],
      verbose: true,
    });

    console.log('\n--- Ingest Summary ---');
    console.log(`  Files processed: ${result.filesProcessed}`);
    console.log(`  Files skipped:   ${result.filesSkipped}`);
    console.log(`  Files errored:   ${result.filesErrored}`);
    console.log(`  Chunks created:  ${result.chunksCreated}`);
    console.log(`  Duration:        ${result.durationMs}ms`);

    if (result.errors.length > 0) {
      console.log('\n  Errors:');
      for (const e of result.errors) {
        console.log(`    ${e.file}: ${e.error}`);
      }
    }

    // Re-ingest to test skip detection
    console.log('\n--- Re-ingest (should skip all) ---');
    const reResult = await ingestDirectory(coll, srcDir, {
      extensions: ['.ts'],
      verbose: true,
    });
    const skipPass = reResult.filesSkipped === result.filesProcessed && reResult.filesProcessed === 0;
    console.log(`Skip detection: ${skipPass ? 'PASS' : 'FAIL'}`);

    // Query tests
    console.log('\n--- Query Tests ---\n');

    const queries = [
      'cosine similarity search',
      'embedding provider interface',
      'markdown heading chunking',
      'create collection pgvector',
      'git branch commit hash',
    ];

    for (const q of queries) {
      const results = await coll.query(q, { limit: 3 });
      console.log(`Query: "${q}"`);
      for (const r of results) {
        console.log(`  score=${r.score.toFixed(4)}  file=${r.filePath}  chunk=${r.chunkIndex}`);
      }
      console.log();
    }

    // Final count
    const count = await coll.count();
    console.log(`Total chunks in collection: ${count}`);

    // Cleanup
    await kvec.deleteCollection(COLLECTION_NAME);
    console.log(`\nCleaned up collection. All done.`);
  } catch (err) {
    console.error('\nTest FAILED:', err);
    try { await kvec.deleteCollection(COLLECTION_NAME); } catch {}
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
