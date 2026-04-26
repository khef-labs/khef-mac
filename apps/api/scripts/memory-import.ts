/**
 * Import memories from exported markdown files into the database via API.
 *
 * Usage:
 *   npm run memory:import                              # import all from tmp/export/memories/
 *   npm run memory:import -- user                      # import only user project
 *   npm run memory:import -- khef --type context    # import only context type from khef
 *   npm run memory:import -- --path /some/dir          # import from custom path
 *
 * Requires the khef API server to be running.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const API_URL = process.env.KHEF_API_URL || 'http://localhost:3100';
const DEFAULT_IMPORT_DIR = join(__dirname, '..', 'tmp', 'export', 'memories');

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

interface FrontMatter {
  project: string;
  handle: string;
  title: string;
  type: string;
  subtype: string;
  tags?: string[];
  metadata?: Record<string, string>;
}

const KNOWN_FRONTMATTER_KEYS = new Set(['project', 'handle', 'title', 'type', 'subtype', 'tags']);

function parseFrontMatter(md: string): { meta: Record<string, any>; body: string } {
  const lines = md.split(/\r?\n/);
  if (lines[0] !== '---') {
    throw new Error('Missing front matter delimiter (---) at top of file');
  }
  const meta: Record<string, any> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '---') { i++; break; }
    const m = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (m) {
      const key = m[1];
      let value = m[2].trim();
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).trim();
        meta[key] = value ? value.split(',').map((v: string) => v.trim()) : [];
      } else {
        meta[key] = value;
      }
    }
  }
  const body = lines.slice(i).join('\n');
  return { meta, body };
}

function collectMarkdownFiles(baseDir: string, rel = ''): string[] {
  const dir = join(baseDir, rel);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const childRel = rel ? join(rel, name) : name;
    const full = join(baseDir, childRel);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectMarkdownFiles(baseDir, childRel));
    } else if (name.endsWith('.md')) {
      out.push(childRel);
    }
  }
  return out;
}

type ImportResult = 'created' | 'updated' | 'unchanged' | 'skipped';

interface ImportEntry {
  relPath: string;
  result: ImportResult;
  error?: string;
}

const projectIdCache = new Map<string, string>();
const memoryTypeCache = new Map<string, { type: string; parent_type?: string | null }>();

async function resolveProjectId(handle: string): Promise<string> {
  const cached = projectIdCache.get(handle);
  if (cached) return cached;

  const res = await fetch(`${API_URL}/api/projects?handle=${encodeURIComponent(handle)}`);
  if (!res.ok) {
    throw new Error(`Failed to look up project: ${handle} (${res.status})`);
  }
  const data = await res.json() as { projects: { id: string }[] };
  if (data.projects.length === 0) {
    throw new Error(`Project not found: ${handle}`);
  }
  const id = data.projects[0].id;
  projectIdCache.set(handle, id);
  return id;
}

async function resolveMemoryType(name: string): Promise<{ type: string; parent_type?: string | null }> {
  const cached = memoryTypeCache.get(name);
  if (cached) return cached;

  const res = await fetch(`${API_URL}/api/memory-types/${encodeURIComponent(name)}`);
  if (!res.ok) {
    throw new Error(`Failed to look up memory type: ${name} (${res.status})`);
  }
  const data = await res.json() as { memory_type: { type: string; parent_type?: string | null } };
  const memoryType = {
    type: data.memory_type.type,
    parent_type: data.memory_type.parent_type ?? null,
  };
  memoryTypeCache.set(name, memoryType);
  return memoryType;
}

function tagsMatch(apiTags: { id: string; name: string }[] | undefined, fileTags: string[] | undefined): boolean {
  const a = (apiTags || []).map(t => t.name).sort();
  const b = (fileTags || []).sort();
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

async function setMemoryMetadata(memoryId: string, field: string, value: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/memories/${memoryId}/metadata/${encodeURIComponent(field)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Metadata update failed (${res.status}): ${text}`);
  }
}

async function findExistingMemory(handle: string, projectHandle: string, projectId: string): Promise<any | null> {
  // Search for the memory by handle and project
  const params = new URLSearchParams({
    handle,
    project_handle: projectHandle,
    compact: 'true',
    limit: '1',
  });
  const res = await fetch(`${API_URL}/api/memories?${params}`);
  if (!res.ok) return null;
  const data = await res.json() as { memories: any[] };
  if (data.memories.length === 0) return null;

  // Fetch full memory with tags via project-scoped endpoint
  const memoryId = data.memories[0].id;
  const fullRes = await fetch(`${API_URL}/api/projects/${projectId}/memories/${memoryId}`);
  if (!fullRes.ok) return null;
  const fullData = await fullRes.json() as { memory: any };
  return fullData.memory;
}

async function createMemory(projectId: string, seed: FrontMatter, content: string): Promise<string> {
  const body: Record<string, any> = {
    handle: seed.handle,
    title: seed.title,
    content,
    type: seed.type,
  };
  if (seed.tags && seed.tags.length > 0) {
    body.tags = seed.tags;
  }
  const res = await fetch(`${API_URL}/api/projects/${projectId}/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST failed (${res.status}): ${text}`);
  }
  const data = await res.json() as { memory?: { id: string } };
  if (!data.memory?.id) {
    throw new Error('POST succeeded but did not return memory id');
  }
  return data.memory.id;
}

async function updateMemory(projectId: string, memoryId: string, seed: FrontMatter, content: string): Promise<void> {
  const body: Record<string, any> = {
    title: seed.title,
    content,
    type: seed.type,
  };
  if (seed.tags !== undefined) {
    body.tags = seed.tags || [];
  }
  const res = await fetch(`${API_URL}/api/projects/${projectId}/memories/${memoryId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH failed (${res.status}): ${text}`);
  }
}

async function importFile(filePath: string, baseDir: string): Promise<ImportEntry> {
  const relPath = relative(baseDir, filePath);

  let md: string;
  try {
    md = readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    return { relPath, result: 'skipped', error: `Cannot read file: ${err.message}` };
  }

  let meta: Record<string, any>;
  let body: string;
  try {
    ({ meta, body } = parseFrontMatter(md));
  } catch (err: any) {
    return { relPath, result: 'skipped', error: `Invalid frontmatter: ${err.message}` };
  }

  const missing: string[] = [];
  if (!meta.project) missing.push('project');
  if (!meta.handle) missing.push('handle');
  if (!meta.title) missing.push('title');
  if (!meta.type) missing.push('type');
  if (!meta.subtype) missing.push('subtype');
  if (missing.length > 0) {
    return { relPath, result: 'skipped', error: `Missing frontmatter: ${missing.join(', ')}` };
  }

  // Extract metadata fields (anything not in known frontmatter keys)
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(key) && value !== undefined && value !== null) {
      metadata[key] = String(value);
    }
  }

  const seed: FrontMatter = {
    project: String(meta.project),
    handle: String(meta.handle),
    title: String(meta.title),
    type: String(meta.type),
    subtype: String(meta.subtype),
    tags: Array.isArray(meta.tags) ? meta.tags : undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
  const content = String(body || '').trim();

  const subtypeInfo = await resolveMemoryType(seed.subtype);
  if (seed.type !== seed.subtype && subtypeInfo.parent_type !== seed.type) {
    return {
      relPath,
      result: 'skipped',
      error: `Subtype '${seed.subtype}' does not belong to type '${seed.type}'`,
    };
  }
  const actualType = seed.subtype;

  const projectId = await resolveProjectId(seed.project);
  const existing = await findExistingMemory(seed.handle, seed.project, projectId);

  if (existing) {
    const contentChanged = existing.content !== content;
    const titleChanged = existing.title !== seed.title;
    const typeChanged = existing.type !== actualType;
    const tagsChanged = !tagsMatch(existing.tags, seed.tags);

    if (contentChanged || titleChanged || typeChanged || tagsChanged) {
      await updateMemory(projectId, existing.id, { ...seed, type: actualType }, content);
      if (seed.metadata) {
        for (const [field, value] of Object.entries(seed.metadata)) {
          await setMemoryMetadata(existing.id, field, value);
        }
      }
      return { relPath, result: 'updated' };
    }
    if (seed.metadata) {
      for (const [field, value] of Object.entries(seed.metadata)) {
        await setMemoryMetadata(existing.id, field, value);
      }
    }
    return { relPath, result: 'unchanged' };
  }

  const createdId = await createMemory(projectId, { ...seed, type: actualType }, content);
  if (seed.metadata) {
    for (const [field, value] of Object.entries(seed.metadata)) {
      await setMemoryMetadata(createdId, field, value);
    }
  }
  return { relPath, result: 'created' };
}

async function main() {
  const args = parseArgs();
  const sourceDir = args.path ? resolve(args.path) : DEFAULT_IMPORT_DIR;

  const allFiles = collectMarkdownFiles(sourceDir);
  if (allFiles.length === 0) {
    console.log(`No markdown files found in ${sourceDir}`);
    process.exit(0);
  }

  // Filter files by project handle and type from directory structure
  // Expected layout: {project}/{type}/{nn}-{handle}.md
  let filtered = allFiles;

  if (args.handles.length > 0) {
    filtered = filtered.filter(rel => {
      const parts = rel.split(/[\\/]/);
      return parts.length > 1 && args.handles.includes(parts[0]);
    });
  }

  if (args.type) {
    const types = args.type.split(',').map(t => t.trim());
    filtered = filtered.filter(rel => {
      const parts = rel.split(/[\\/]/);
      return parts.length > 2 && types.includes(parts[1]);
    });
  }

  if (filtered.length === 0) {
    const filters = [
      args.handles.length > 0 && `project=${args.handles.join(',')}`,
      args.type && `type=${args.type}`,
    ].filter(Boolean).join(', ');
    console.log(`No matching files found (${filters})`);
    process.exit(0);
  }

  const filters = [
    args.handles.length > 0 && `project=${args.handles.join(',')}`,
    args.type && `type=${args.type}`,
  ].filter(Boolean).join(', ');

  console.log(`Importing memories${filters ? ` (${filters})` : ''}...`);
  if (args.path) console.log(`Source: ${sourceDir}`);
  console.log();

  const results: ImportEntry[] = [];

  for (const relPath of filtered) {
    const fullPath = join(sourceDir, relPath);
    const entry = await importFile(fullPath, sourceDir);
    results.push(entry);

    const symbol = entry.result === 'created' ? '+'
      : entry.result === 'updated' ? '~'
      : entry.result === 'skipped' ? '!'
      : ' ';
    const suffix = entry.error ? ` (${entry.error})` : '';
    console.log(`  ${symbol} ${entry.relPath} → ${entry.result}${suffix}`);
  }

  const created = results.filter(r => r.result === 'created').length;
  const updated = results.filter(r => r.result === 'updated').length;
  const unchanged = results.filter(r => r.result === 'unchanged').length;
  const skipped = results.filter(r => r.result === 'skipped').length;

  const parts = [
    created > 0 && `${created} created`,
    updated > 0 && `${updated} updated`,
    unchanged > 0 && `${unchanged} unchanged`,
    skipped > 0 && `${skipped} skipped`,
  ].filter(Boolean).join(', ');

  console.log(`\nImported ${results.length} file(s): ${parts}.`);

  if (skipped > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
