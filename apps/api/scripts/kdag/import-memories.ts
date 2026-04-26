#!/usr/bin/env tsx
/**
 * Kdag code step: Import memories from an enriched manifest.
 *
 * Input (stdin): JSON manifest with file entries (including ai_tags from enrich step)
 * Output (stdout): JSON summary of import results
 */

import { readFileSync } from 'fs';

const API_BASE = process.env.KHEF_API_URL || 'http://localhost:3201';

interface FileEntry {
  path: string;
  handle: string;
  title: string;
  category: string;
  category_tag: string;
  ai_tags?: string[];
}

interface Manifest {
  project_handle: string;
  memory_type: string;
  collection_handle: string | null;
  import_tag: string;
  files: FileEntry[];
}

interface ImportResult {
  handle: string;
  title: string;
  action: 'created' | 'updated' | 'failed';
  memory_id?: string;
  error?: string;
}

async function resolveProjectId(handle: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/projects?handle=${encodeURIComponent(handle)}`);
  if (!res.ok) throw new Error(`Failed to look up project '${handle}' (${res.status})`);
  const data = await res.json() as { projects: { id: string }[] };
  if (data.projects.length === 0) throw new Error(`Project '${handle}' not found`);
  return data.projects[0].id;
}

async function resolveCollectionId(projectId: string, collectionHandle: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/collections?limit=100`);
  if (!res.ok) throw new Error(`Failed to list collections (${res.status})`);
  const data = await res.json() as { collections: { id: string; handle: string }[] };
  const col = data.collections.find(c => c.handle === collectionHandle);
  if (col) return col.id;

  // Auto-create the collection
  const name = collectionHandle.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const createRes = await fetch(`${API_BASE}/api/projects/${projectId}/collections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: collectionHandle, name }),
  });
  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error || `Failed to create collection '${collectionHandle}' (${createRes.status})`);
  }
  const created = await createRes.json() as { collection: { id: string } };
  console.error(`Auto-created collection '${collectionHandle}'`);
  return created.collection.id;
}

async function findExistingMemory(projectId: string, handle: string): Promise<string | null> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/memories?handle=${encodeURIComponent(handle)}&limit=1`);
  if (!res.ok) return null;
  const data = await res.json() as { memories: { id: string }[] };
  return data.memories.length > 0 ? data.memories[0].id : null;
}

async function createMemory(
  projectId: string,
  entry: FileEntry,
  content: string,
  type: string,
  tags: string[]
): Promise<string> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      handle: entry.handle,
      title: entry.title,
      content,
      type,
      tags,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error || `Create failed (${res.status})`);
  }
  const data = await res.json() as { memory: { id: string } };
  return data.memory.id;
}

async function updateMemory(
  projectId: string,
  memoryId: string,
  entry: FileEntry,
  content: string,
  type: string,
  tags: string[]
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/memories/${memoryId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: entry.title,
      content,
      type,
      tags,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error || `Update failed (${res.status})`);
  }
}

async function addToCollection(projectId: string, collectionId: string, memoryId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/collections/${collectionId}/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memory_id: memoryId }),
  });
  // 409 = already in collection, that's fine
  if (!res.ok && res.status !== 409) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error || `Add to collection failed (${res.status})`);
  }
}

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const cleaned = input.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    const manifest: Manifest = JSON.parse(cleaned);

    const projectId = await resolveProjectId(manifest.project_handle);

    let collectionId: string | null = null;
    if (manifest.collection_handle) {
      collectionId = await resolveCollectionId(projectId, manifest.collection_handle);
    }

    const results: ImportResult[] = [];

    for (const entry of manifest.files) {
      try {
        const content = readFileSync(entry.path, 'utf-8');
        const tags = [
          manifest.import_tag,
          entry.category_tag,
          ...(entry.ai_tags || []),
        ];

        const existingId = await findExistingMemory(projectId, entry.handle);
        let memoryId: string;

        if (existingId) {
          await updateMemory(projectId, existingId, entry, content, manifest.memory_type, tags);
          memoryId = existingId;
          results.push({ handle: entry.handle, title: entry.title, action: 'updated', memory_id: memoryId });
        } else {
          memoryId = await createMemory(projectId, entry, content, manifest.memory_type, tags);
          results.push({ handle: entry.handle, title: entry.title, action: 'created', memory_id: memoryId });
        }

        if (collectionId) {
          await addToCollection(projectId, collectionId, memoryId);
        }
      } catch (err: any) {
        results.push({ handle: entry.handle, title: entry.title, action: 'failed', error: err.message });
      }
    }

    const created = results.filter(r => r.action === 'created').length;
    const updated = results.filter(r => r.action === 'updated').length;
    const failed = results.filter(r => r.action === 'failed').length;

    const output = {
      summary: { created, updated, failed, total: manifest.files.length },
      import_tag: manifest.import_tag,
      collection_handle: manifest.collection_handle,
      results,
    };

    process.stdout.write(JSON.stringify(output, null, 2));
  } catch (err: any) {
    console.error(`Failed to import: ${err.message}`);
    process.exit(1);
  }
});
