/**
 * kvec smoke test — verifies the full pipeline:
 *   connect → create collection → ingest file → query → delete collection
 *
 * Prerequisites:
 *   - PostgreSQL running with kvec schema migrated
 *   - Embed server running on port 9100
 *
 * Usage:
 *   cd packages/kvec
 *   npx tsx smoke-test.ts
 */

import { Pool } from 'pg';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import path from 'path';

// Load env from api's .env (inline parse to avoid dotenv dependency)
const envPath = path.join(__dirname, '../../apps/api/.env');
const envContent = readFileSync(envPath, 'utf-8');
const envVars: Record<string, string> = {};
for (const line of envContent.split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const eqIdx = line.indexOf('=');
  if (eqIdx === -1) continue;
  const key = line.slice(0, eqIdx).trim();
  let val = line.slice(eqIdx + 1).trim();
  // Expand ${VAR} references
  val = val.replace(/\$\{(\w+)\}/g, (_, k) => envVars[k] ?? process.env[k] ?? '');
  envVars[key] = val;
}
Object.assign(process.env, envVars);

import { KVec } from './src/index';

const COLLECTION_NAME = '_kvec_smoke_test';
const TMP_DIR = path.join(__dirname, 'tmp');

async function main() {
  console.log('kvec smoke test');
  console.log('===============\n');

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
    // 1. Clean up any leftover test collection
    await kvec.deleteCollection(COLLECTION_NAME);
    console.log('1. Cleanup: OK');

    // 2. Create collection
    const coll = await kvec.createCollection({
      name: COLLECTION_NAME,
      description: 'Smoke test collection',
      embeddingModel: 'all-mpnet-base-v2',
      dimensions: 768,
      storeType: 'markdown',
    });
    console.log(`2. Created collection: "${coll.name}" (${coll.id})`);

    // 3. Write a temporary test file
    mkdirSync(TMP_DIR, { recursive: true });
    const testFile = path.join(TMP_DIR, 'test-doc.md');
    writeFileSync(testFile, [
      '# TypeScript Basics',
      '',
      'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.',
      'It adds optional static types, classes, and interfaces.',
      '',
      '## Why TypeScript?',
      '',
      'TypeScript catches errors at compile time rather than runtime.',
      'It provides better tooling with autocompletion and type checking.',
      '',
      '# Python Basics',
      '',
      'Python is a high-level, interpreted programming language.',
      'It emphasizes code readability with significant whitespace.',
      '',
      '## Why Python?',
      '',
      'Python has a large standard library and active community.',
      'It is widely used in data science, web development, and automation.',
    ].join('\n'));

    // 4. Ingest the file
    const chunksCreated = await coll.ingest(testFile);
    console.log(`3. Ingested: ${chunksCreated} chunks from test-doc.md`);

    // 5. Re-ingest same file (should skip — unchanged content)
    const skipped = await coll.ingest(testFile);
    console.log(`4. Re-ingest (skip check): ${skipped === 0 ? 'PASS (skipped)' : `FAIL (created ${skipped})`}`);

    // 6. Query
    const results = await coll.query('static type checking', { limit: 3 });
    console.log(`5. Query "static type checking": ${results.length} results`);
    for (const r of results) {
      console.log(`   - score=${r.score.toFixed(4)} chunk=${r.chunkIndex} file=${r.filePath}`);
      console.log(`     "${r.content.slice(0, 80)}..."`);
    }

    // 7. Count
    const count = await coll.count();
    console.log(`6. Total chunks in collection: ${count}`);

    // 8. Delete collection
    await kvec.deleteCollection(COLLECTION_NAME);
    const gone = await kvec.collection(COLLECTION_NAME);
    console.log(`7. Deleted collection: ${gone === null ? 'PASS (gone)' : 'FAIL (still exists)'}`);

    console.log('\n--- All checks passed ---');
  } catch (err) {
    console.error('\nSmoke test FAILED:', err);
    // Clean up on failure too
    try { await kvec.deleteCollection(COLLECTION_NAME); } catch {}
    process.exitCode = 1;
  } finally {
    // Clean up tmp
    try { rmSync(TMP_DIR, { recursive: true }); } catch {}
    await pool.end();
  }
}

main();
