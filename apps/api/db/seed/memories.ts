import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { sanitizeTags } from '../../src/utils/tags';

const CHUNK_SIZE = 2000;

const chunkText = (text: string): string[] => {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + CHUNK_SIZE));
    start += CHUNK_SIZE;
  }
  return chunks;
};

type MemorySeed = {
  project: string;
  handle: string;
  title: string;
  type: string; // memory type name (e.g., 'assistant-rule')
  subtype?: string; // child type (e.g., 'context' under 'knowledge') — used for type and status resolution
  status?: string; // status value (e.g., 'inactive', 'current', 'active') — uses type default if omitted
  tags?: string[];
  content: string;
  metadata?: Record<string, string>;
  seedPath?: string; // relative path from repo root (e.g., 'apps/api/db/seed/memories/khef/assistant-rule/01-foo.md')
};

const KNOWN_FRONTMATTER_KEYS = new Set(['project', 'handle', 'title', 'type', 'subtype', 'tags', 'status']);

function parseFrontMatter(md: string): { meta: any; body: string } {
  const lines = md.split(/\r?\n/);
  if (lines[0] !== '---') {
    throw new Error('Missing front matter delimiter (---) at top of file');
  }
  const meta: any = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '---') { i++; break; }
    const m = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (m) {
      const key = m[1];
      let value = m[2].trim();
      // parse array values like [a, b]
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
  const entries = readdirSync(dir);
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

function loadMemorySeeds(baseDir: string): MemorySeed[] {
  const files = collectMarkdownFiles(baseDir);
  const seeds: MemorySeed[] = [];
  for (const relPath of files) {
    const full = join(baseDir, relPath);
    const md = readFileSync(full, 'utf-8');
    const { meta, body } = parseFrontMatter(md);

    // Determine project from folder name if not specified in front matter
    // Expect layout: baseDir/<project>/<file>.md or baseDir/<file>.md
    const parts = relPath.split(/\\|\//);
    const projectFromPath = parts.length > 1 ? parts[0] : undefined;

    const handle = meta.handle && String(meta.handle).trim().length > 0 ? String(meta.handle) : null;
    const title = meta.title && String(meta.title).trim().length > 0 ? String(meta.title) : null;
    const type = meta.type && String(meta.type).trim().length > 0 ? String(meta.type) : null;
    // Extract metadata fields (anything not in known frontmatter keys)
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(meta)) {
      if (!KNOWN_FRONTMATTER_KEYS.has(key) && value !== undefined && value !== null) {
        metadata[key] = String(value);
      }
    }

    const project = meta.project && String(meta.project).trim().length > 0
      ? String(meta.project)
      : (projectFromPath || null);

    const missing: string[] = [];
    if (!project) missing.push('project');
    if (!handle) missing.push('handle');
    if (!title) missing.push('title');
    if (!type) missing.push('type');
    if (missing.length > 0) {
      throw new Error(`Missing required front matter ${missing.join(', ')} in ${relPath}`);
    }

    seeds.push({
      project: project!,
      handle: handle!,
      title: title!,
      type: type!,
      subtype: meta.subtype && String(meta.subtype).trim().length > 0 ? String(meta.subtype).trim() : undefined,
      status: meta.status && String(meta.status).trim().length > 0 ? String(meta.status).trim() : undefined,
      tags: Array.isArray(meta.tags) ? meta.tags : undefined,
      content: String(body || '').trim(),
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      seedPath: `apps/api/db/seed/memories/${relPath}`,
    });
  }
  return seeds;
}

async function getProjectByHandle(client: Client, handle: string) {
  const res = await client.query<{ id: string }>('SELECT id FROM projects WHERE handle = $1', [handle]);
  return res.rows.length > 0 ? res.rows[0].id : null;
}

async function getMemoryTypeId(client: Client, name: string) {
  const res = await client.query<{ id: string }>('SELECT id FROM memory_types WHERE name = $1', [name]);
  if (res.rows.length === 0) throw new Error(`Memory type not found: ${name}`);
  return res.rows[0].id;
}

async function getDefaultStatusId(client: Client, memoryTypeId: string) {
  // Try own statuses first
  let res = await client.query<{ id: string }>(
    'SELECT id FROM memory_type_statuses WHERE memory_type_id = $1 AND sort_order = 0 LIMIT 1',
    [memoryTypeId]
  );
  // Fall back to parent type's statuses
  if (res.rows.length === 0) {
    res = await client.query<{ id: string }>(
      `SELECT mts.id FROM memory_type_statuses mts
       INNER JOIN memory_types mt ON mt.parent_id = mts.memory_type_id
       WHERE mt.id = $1
       ORDER BY mts.sort_order LIMIT 1`,
      [memoryTypeId]
    );
  }
  return res.rows.length > 0 ? res.rows[0].id : null;
}

async function getStatusIdByValue(client: Client, memoryTypeId: string, statusValue: string) {
  // Try own statuses first
  let res = await client.query<{ id: string }>(
    'SELECT id FROM memory_type_statuses WHERE memory_type_id = $1 AND status_value = $2 LIMIT 1',
    [memoryTypeId, statusValue]
  );
  // Fall back to parent type's statuses
  if (res.rows.length === 0) {
    res = await client.query<{ id: string }>(
      `SELECT mts.id FROM memory_type_statuses mts
       INNER JOIN memory_types mt ON mt.parent_id = mts.memory_type_id
       WHERE mt.id = $1 AND mts.status_value = $2
       LIMIT 1`,
      [memoryTypeId, statusValue]
    );
  }
  return res.rows.length > 0 ? res.rows[0].id : null;
}

async function getMetadataId(client: Client, field: string) {
  const res = await client.query<{ id: string }>(
    'SELECT id FROM metadata WHERE entity_type = $1 AND field = $2',
    ['memory', field]
  );
  return res.rows.length > 0 ? res.rows[0].id : null;
}

export async function seedMemoriesForProject(client: Client, projectHandle: string) {
  const baseDir = join(__dirname, 'memories');
  const seeds = loadMemorySeeds(baseDir).filter(s => s.project === projectHandle);
  if (seeds.length === 0) {
    console.log(`No memory seeds found for project '${projectHandle}'.`);
    return;
  }

  const projectId = await getProjectByHandle(client, projectHandle);
  if (!projectId) {
    throw new Error(`Project not found: ${projectHandle}`);
  }

  console.log(`\nSeeding ${seeds.length} memories for '${projectHandle}'...`);

  // Cache metadata field IDs as we encounter them
  const metadataIdCache = new Map<string, string | null>();

  for (const s of seeds) {
    // Use subtype for type resolution when present (e.g., type=knowledge + subtype=context → context)
    const effectiveType = s.subtype || s.type;
    const memoryTypeId = await getMemoryTypeId(client, effectiveType);
    let statusId: string | null;
    if (s.status) {
      statusId = await getStatusIdByValue(client, memoryTypeId, s.status);
      if (!statusId) {
        throw new Error(`Invalid status '${s.status}' for type '${effectiveType}' in seed '${s.handle}'`);
      }
    } else {
      statusId = await getDefaultStatusId(client, memoryTypeId);
    }

    await client.query('BEGIN');
    try {
      // Match by handle first (unique constraint is project_id + handle, not type)
      const byHandle = await client.query<{ id: string; content: string; title: string }>(
        'SELECT id, title, content FROM memories WHERE project_id = $1 AND handle = $2',
        [projectId, s.handle]
      );

      let memoryId: string | null = null;

      if (byHandle.rows.length > 0) {
        memoryId = byHandle.rows[0].id;
        const needsContentUpdate = byHandle.rows[0].content !== s.content || byHandle.rows[0].title !== s.title;
        if (needsContentUpdate || s.status) {
          await client.query(
            'UPDATE memories SET title = $1, content = $2, status_id = COALESCE($4, status_id), status_updated_at = CASE WHEN $4::uuid IS NOT NULL THEN NOW() ELSE status_updated_at END WHERE id = $3',
            [s.title, s.content, memoryId, s.status ? statusId : null]
          );
          await client.query('DELETE FROM memory_chunks WHERE memory_id = $1', [memoryId]);
          const chunks = chunkText(s.content);
          if (chunks.length > 1) {
            for (let i = 0; i < chunks.length; i++) {
              await client.query(
                'INSERT INTO memory_chunks (memory_id, chunk_index, content) VALUES ($1, $2, $3)',
                [memoryId, i, chunks[i]]
              );
            }
          }
        }
      } else {
        // Fallback: match by title then converge to desired handle if free
        const byTitle = await client.query<{ id: string; handle: string }>(
          'SELECT id, handle FROM memories WHERE project_id = $1 AND title = $2',
          [projectId, s.title]
        );
        if (byTitle.rows.length > 0) {
          memoryId = byTitle.rows[0].id;
          if (byTitle.rows[0].handle !== s.handle) {
            const conflict = await client.query('SELECT 1 FROM memories WHERE project_id = $1 AND handle = $2 AND id <> $3', [projectId, s.handle, memoryId]);
            if (conflict.rows.length === 0) {
              await client.query('UPDATE memories SET handle = $1 WHERE id = $2', [s.handle, memoryId]);
            } else {
              console.warn(`Seed: handle '${s.handle}' already in use; leaving handle for title '${s.title}' unchanged`);
            }
          }
          await client.query(
            'UPDATE memories SET content = $1, status_id = COALESCE($3, status_id), status_updated_at = CASE WHEN $3::uuid IS NOT NULL THEN NOW() ELSE status_updated_at END WHERE id = $2',
            [s.content, memoryId, s.status ? statusId : null]
          );
          await client.query('DELETE FROM memory_chunks WHERE memory_id = $1', [memoryId]);
          const chunks = chunkText(s.content);
          if (chunks.length > 1) {
            for (let i = 0; i < chunks.length; i++) {
              await client.query(
                'INSERT INTO memory_chunks (memory_id, chunk_index, content) VALUES ($1, $2, $3)',
                [memoryId, i, chunks[i]]
              );
            }
          }
        } else {
          // Create new
          const ins = await client.query<{ id: string }>(
            'INSERT INTO memories (project_id, handle, title, content, memory_type_id, status_id, status_updated_at) VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id',
            [projectId, s.handle, s.title, s.content, memoryTypeId, statusId]
          );
          memoryId = ins.rows[0].id;
          const chunks = chunkText(s.content);
          if (chunks.length > 1) {
            for (let i = 0; i < chunks.length; i++) {
              await client.query(
                'INSERT INTO memory_chunks (memory_id, chunk_index, content) VALUES ($1, $2, $3)',
                [memoryId, i, chunks[i]]
              );
            }
          }
        }
      }

      // Tags
      if (memoryId && s.tags && s.tags.length) {
        const validTags = sanitizeTags(s.tags);
        for (const name of validTags) {
          const tag = await client.query<{ id: string }>(
            'INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
            [name]
          );
          await client.query(
            'INSERT INTO memory_tags (memory_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [memoryId, tag.rows[0].id]
          );
        }
      }

      // Always store seed-path metadata, merging with any frontmatter metadata
      const seedMetadata: Record<string, string> = { ...s.metadata, 'seed-path': s.seedPath! };

      if (memoryId) {
        for (const [field, value] of Object.entries(seedMetadata)) {
          if (!metadataIdCache.has(field)) {
            metadataIdCache.set(field, await getMetadataId(client, field));
          }
          const metadataId = metadataIdCache.get(field);
          if (metadataId) {
            await client.query(
              `INSERT INTO memory_metadata (memory_id, metadata_id, value)
               VALUES ($1, $2, $3)
               ON CONFLICT (memory_id, metadata_id)
               DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
              [memoryId, metadataId, value]
            );
          }
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
}

export function listSeedProjects(): string[] {
  const baseDir = join(__dirname, 'memories');
  const seeds = loadMemorySeeds(baseDir);
  const set = new Set<string>();
  for (const s of seeds) set.add(s.project);
  return Array.from(set).sort();
}
