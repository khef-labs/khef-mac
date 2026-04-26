/**
 * Embed source code into kvec.
 *
 * Usage:
 *   npm run kvec:embed                              # embed current directory
 *   npm run kvec:embed -- /path/to/dir              # embed specific directory
 *   npm run kvec:embed -- /path/to/file.ts          # embed single file
 *   npm run kvec:embed -- -c my-collection          # custom collection name
 *   npm run kvec:embed -- -e .ts,.js,.py            # filter extensions
 *   npm run kvec:embed -- --limit 10                # limit files
 *
 * Requires:
 *   - PostgreSQL with kvec schema
 *   - Embed server running (port 9100) or embed.py available for fallback
 */

import { execSync } from 'child_process';
import { readFileSync, statSync } from 'fs';
import { resolve, join, extname, basename, dirname } from 'path';
import { homedir } from 'os';
import { Pool } from 'pg';
import { KVec, IngestOptions, ingestDirectory } from '@khef/kvec';

// ---------------------------------------------------------------------------
// Load .env
// ---------------------------------------------------------------------------

const envPath = join(__dirname, '..', '.env');
try {
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
} catch {
  // .env not found — rely on existing env vars
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliArgs {
  inputPath: string;
  collection: string;
  extensions: string[];
  limit: number;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  // INIT_CWD is set by npm to the original cwd before --prefix changes it
  const cwd = process.env.INIT_CWD || process.cwd();
  let inputPath = cwd;
  let collection = 'kvec-source';
  let extensions: string[] = [];
  let limit = 0;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-c' || arg === '--collection') {
      collection = argv[++i];
    } else if (arg === '-e' || arg === '--extensions') {
      extensions = argv[++i].split(',').map((e) => (e.startsWith('.') ? e : `.${e}`));
    } else if (arg === '-l' || arg === '--limit') {
      limit = parseInt(argv[++i], 10);
    } else if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      const expanded = arg.startsWith('~/') ? join(homedir(), arg.slice(2)) : arg;
      inputPath = resolve(cwd, expanded);
    }
  }

  return { inputPath, collection, extensions, limit };
}

function printUsage() {
  console.log(`Usage: npm run kvec:embed -- [path] [options]

Arguments:
  path                    File or directory to embed (default: current directory)

Options:
  -c, --collection NAME   Collection name (default: kvec-source)
  -e, --extensions LIST   Comma-separated extensions, e.g. .ts,.js,.py
  -l, --limit N           Max files to process
  -h, --help              Show this help`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const EMBEDDING_MODEL = 'all-mpnet-base-v2';
const DIMENSIONS = 768;

async function main() {
  const args = parseArgs();

  // Verify input exists
  let stat;
  try {
    stat = statSync(args.inputPath);
  } catch {
    console.error(`Path not found: ${args.inputPath}`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const kvec = new KVec({
    pool,
    embedding: {
      provider: 'python-sidecar',
      serverUrl: 'http://127.0.0.1:9100',
      scriptPath: join(__dirname, '..', 'src', 'services', 'vector', 'embed.py'),
      model: EMBEDDING_MODEL,
    },
  });

  try {
    // Get or create collection
    let coll = await kvec.collection(args.collection);
    if (!coll) {
      const storeType = stat.isFile() ? detectStoreType(args.inputPath) : 'source-code';
      coll = await kvec.createCollection({
        name: args.collection,
        description: `Embedded source code`,
        embeddingModel: EMBEDDING_MODEL,
        dimensions: DIMENSIONS,
        storeType,
      });
      console.log(`Created collection: ${args.collection}`);
    } else {
      console.log(`Collection: ${args.collection}`);
    }

    if (stat.isFile()) {
      // Single file — detect git info so path is relative to repo root
      const gitInfo = detectGit(dirname(args.inputPath));
      const ingestOpts: IngestOptions = {};
      if (gitInfo) {
        ingestOpts.repoName = gitInfo.name;
        ingestOpts.repoRootPath = gitInfo.rootPath;
        ingestOpts.remoteUrl = gitInfo.remoteUrl;
        ingestOpts.branch = gitInfo.branch;
        ingestOpts.commitHash = gitInfo.commitHash;
      }

      console.log(`\nEmbedding file: ${args.inputPath}\n`);
      const chunks = await coll.ingest(args.inputPath, ingestOpts);
      if (chunks === 0) {
        console.log(`  SKIP (unchanged)`);
      } else {
        console.log(`  OK (${chunks} chunks)`);
      }
    } else {
      // Directory
      console.log(`\nEmbedding directory: ${args.inputPath}\n`);
      const result = await ingestDirectory(coll, args.inputPath, {
        extensions: args.extensions.length > 0 ? args.extensions : undefined,
        limit: args.limit > 0 ? args.limit : undefined,
        verbose: true,
      });

      console.log(`\nSummary:`);
      console.log(`  Processed: ${result.filesProcessed}`);
      console.log(`  Skipped:   ${result.filesSkipped} (unchanged)`);
      console.log(`  Errors:    ${result.filesErrored}`);
      console.log(`  Chunks:    ${result.chunksCreated}`);
      console.log(`  Duration:  ${(result.durationMs / 1000).toFixed(1)}s`);
    }

    console.log(`\nTotal chunks in collection: ${await coll.count()}`);
  } finally {
    await pool.end();
  }
}

function detectStoreType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.md') return 'markdown';
  return 'source-code';
}

interface GitInfo {
  name: string;
  rootPath: string;
  branch: string;
  commitHash: string;
  remoteUrl: string | undefined;
}

function detectGit(dirPath: string): GitInfo | null {
  try {
    const run = (cmd: string) =>
      execSync(cmd, { cwd: dirPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

    const rootPath = run('git rev-parse --show-toplevel');
    const name = basename(rootPath);
    const branch = run('git rev-parse --abbrev-ref HEAD');
    const commitHash = run('git rev-parse HEAD');
    let remoteUrl: string | undefined;
    try { remoteUrl = run('git remote get-url origin'); } catch {}

    return { name, rootPath, branch, commitHash, remoteUrl };
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
