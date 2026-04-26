/**
 * Export memories to seed files.
 *
 * Usage:
 *   npm run memory:export -- <project-handle> [--type type1,type2] [--tag name] [--status value] [--path dir]
 *   npm run memory:export                     # exports all projects, all types
 *
 * Requires the khef API server to be running.
 */

import { execSync } from 'child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const API_URL = process.env.KHEF_API_URL || 'http://localhost:3100';
const DEFAULT_EXPORT_DIR = join(__dirname, '..', 'tmp', 'export', 'memories');

interface CliArgs {
  handles: string[];
  type?: string;
  tag?: string;
  status?: string;
  path?: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const handles: string[] = [];
  let type: string | undefined;
  let tag: string | undefined;
  let status: string | undefined;
  let path: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--type' && argv[i + 1]) {
      type = argv[++i];
    } else if (argv[i] === '--tag' && argv[i + 1]) {
      tag = argv[++i];
    } else if (argv[i] === '--status' && argv[i + 1]) {
      status = argv[++i];
    } else if (argv[i] === '--path' && argv[i + 1]) {
      path = argv[++i];
    } else if (!argv[i].startsWith('--')) {
      handles.push(argv[i]);
    }
  }

  return { handles, type, tag, status, path };
}

async function fetchProjectHandles(): Promise<string[]> {
  const res = await fetch(`${API_URL}/api/projects`);
  if (!res.ok) throw new Error(`Failed to list projects: ${res.status}`);
  const data = (await res.json()) as { projects: { handle: string }[] };
  return data.projects.map((p) => p.handle);
}

function buildQueryString(args: CliArgs): string {
  const params = new URLSearchParams();
  // Always request seed format
  params.set('format', 'seed');
  if (args.type) params.set('type', args.type);
  if (args.tag) params.set('tag', args.tag);
  if (args.status) params.set('status', args.status);
  return params.toString();
}

async function exportProject(handle: string, qs: string, outputBase: string): Promise<number> {
  const url = `${API_URL}/api/projects/${handle}/memories/export?${qs}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) return 0;
    throw new Error(`Export failed for ${handle}: ${res.status}`);
  }

  const zipBuffer = Buffer.from(await res.arrayBuffer());
  if (zipBuffer.length === 0) return 0;

  // Write zip to temp file and extract
  const tmpZip = join(tmpdir(), `khef-export-${handle}-${Date.now()}.zip`);
  const tmpExtract = join(tmpdir(), `khef-export-${handle}-${Date.now()}`);
  writeFileSync(tmpZip, zipBuffer);
  mkdirSync(tmpExtract, { recursive: true });

  try {
    execSync(`unzip -o "${tmpZip}" -d "${tmpExtract}"`, { stdio: 'pipe' });
  } catch (err: any) {
    // unzip returns exit code 1 for warnings (e.g., empty zip)
    if (err.status > 1) throw err;
  }

  // Read extracted files
  let entries: string[];
  try {
    entries = readdirSync(tmpExtract).filter((f: string) => f.endsWith('.md'));
  } catch {
    return 0;
  }

  if (entries.length === 0) return 0;

  const projectDir = join(outputBase, handle);

  // Group files by type from frontmatter
  const byType = new Map<string, { handle: string; content: string }[]>();

  for (const name of entries) {
    const content = readFileSync(join(tmpExtract, name), 'utf-8');
    const typeMatch = content.match(/^type:\s*(.+)$/m);
    const subtypeMatch = content.match(/^subtype:\s*(.+)$/m);
    const handleMatch = content.match(/^handle:\s*(.+)$/m);
    const type = subtypeMatch ? subtypeMatch[1].trim() : (typeMatch ? typeMatch[1].trim() : 'unknown');
    const memHandle = handleMatch ? handleMatch[1].trim() : name.replace(/\.md$/, '');

    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push({ handle: memHandle, content });
  }

  // Write files into {project}/{type}/ subdirectories
  let totalWritten = 0;
  const exportedTypes = new Set<string>();

  for (const [type, files] of byType) {
    exportedTypes.add(type);
    const typeDir = join(projectDir, type);
    mkdirSync(typeDir, { recursive: true });

    // Sort alphabetically by handle for stable ordering
    files.sort((a, b) => a.handle.localeCompare(b.handle));

    const writtenFilenames = new Set<string>();
    for (let i = 0; i < files.length; i++) {
      const num = String(i + 1).padStart(2, '0');
      const filename = `${num}-${files[i].handle}.md`;
      writtenFilenames.add(filename);
      writeFileSync(join(typeDir, filename), files[i].content, 'utf-8');
      console.log(`  ${handle}/${type}/${filename}`);
      totalWritten++;
    }

    // Clean stale files in this type directory
    cleanStaleTypeDir(typeDir, writtenFilenames);
  }

  // Remove empty type directories (but never custom/)
  cleanEmptyTypeDirs(projectDir);

  // Cleanup temp files
  try {
    rmSync(tmpZip);
    rmSync(tmpExtract, { recursive: true });
  } catch { /* ignore cleanup errors */ }

  return totalWritten;
}

function cleanStaleTypeDir(typeDir: string, currentFilenames: Set<string>) {
  let existing: string[];
  try {
    existing = readdirSync(typeDir);
  } catch {
    return;
  }

  for (const name of existing) {
    if (!name.endsWith('.md')) continue;
    if (currentFilenames.has(name)) continue;

    console.log(`  Removing stale: ${name}`);
    rmSync(join(typeDir, name));
  }
}

function cleanEmptyTypeDirs(projectDir: string) {
  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (name === 'custom') continue;
    const full = join(projectDir, name);
    try {
      const stat = statSync(full);
      if (!stat.isDirectory()) continue;
      const children = readdirSync(full);
      if (children.length === 0) {
        rmSync(full);
      }
    } catch { /* ignore */ }
  }
}

async function main() {
  const args = parseArgs();

  let handles: string[];
  if (args.handles.length > 0) {
    handles = args.handles;
  } else {
    handles = await fetchProjectHandles();
  }

  const outputBase = args.path ? resolve(args.path) : DEFAULT_EXPORT_DIR;
  const qs = buildQueryString(args);
  const filters = [args.type && `type=${args.type}`, args.tag && `tag=${args.tag}`, args.status && `status=${args.status}`]
    .filter(Boolean)
    .join(', ');

  console.log(`Exporting memory seeds${filters ? ` (${filters})` : ''}...`);
  if (args.path) console.log(`Output: ${outputBase}`);
  console.log();

  let totalFiles = 0;

  for (const handle of handles) {
    const count = await exportProject(handle, qs, outputBase);
    if (count === 0 && args.handles.length > 0) {
      console.log(`${handle}: no matching memories found`);
    }
    totalFiles += count;
  }

  console.log(`\nExported ${totalFiles} seed file(s).`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
