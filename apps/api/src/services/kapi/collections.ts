import { query, querySingle } from '../../db/client';
import { KapiError } from './definitions';
import type { KapiCollection } from './types';

const HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateCollectionInput {
  handle: string;
  name: string;
  description?: string | null;
  allow_insecure_tls?: boolean;
}

export interface UpdateCollectionInput {
  handle?: string;
  name?: string;
  description?: string | null;
  allow_insecure_tls?: boolean;
}

function validateHandle(handle: string): void {
  if (!HANDLE_RE.test(handle)) {
    throw new KapiError(400, `Invalid handle: "${handle}" (must be kebab-case)`);
  }
  if (handle.length > 100) {
    throw new KapiError(400, 'Handle exceeds 100 characters');
  }
}

export async function listCollections(): Promise<KapiCollection[]> {
  return query<KapiCollection>(
    `SELECT * FROM kapi.collections ORDER BY name ASC`
  );
}

export async function getCollectionById(id: string): Promise<KapiCollection | null> {
  return querySingle<KapiCollection>(
    `SELECT * FROM kapi.collections WHERE id = $1`,
    [id]
  );
}

export async function getCollectionByHandle(handle: string): Promise<KapiCollection | null> {
  return querySingle<KapiCollection>(
    `SELECT * FROM kapi.collections WHERE handle = $1`,
    [handle]
  );
}

/**
 * Resolve a collection by its UUID or handle. Returns null if not found.
 * Used by routes that accept either form in path params.
 */
export async function resolveCollection(idOrHandle: string): Promise<KapiCollection | null> {
  if (UUID_RE.test(idOrHandle)) {
    return getCollectionById(idOrHandle);
  }
  return getCollectionByHandle(idOrHandle);
}

export async function createCollection(
  input: CreateCollectionInput
): Promise<KapiCollection> {
  validateHandle(input.handle);
  if (!input.name?.trim()) {
    throw new KapiError(400, 'name is required');
  }

  const existing = await getCollectionByHandle(input.handle);
  if (existing) {
    throw new KapiError(409, `Collection "${input.handle}" already exists`);
  }

  const row = await querySingle<KapiCollection>(
    `INSERT INTO kapi.collections (handle, name, description, allow_insecure_tls)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      input.handle,
      input.name,
      input.description ?? null,
      input.allow_insecure_tls ?? false,
    ]
  );

  if (!row) throw new KapiError(500, 'Failed to create collection');
  return row;
}

export async function updateCollection(
  id: string,
  input: UpdateCollectionInput
): Promise<KapiCollection> {
  const existing = await getCollectionById(id);
  if (!existing) throw new KapiError(404, 'Collection not found');

  if (input.handle !== undefined && input.handle !== existing.handle) {
    validateHandle(input.handle);
    const conflict = await getCollectionByHandle(input.handle);
    if (conflict) {
      throw new KapiError(409, `Collection "${input.handle}" already exists`);
    }
  }

  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  const push = (col: string, value: unknown) => {
    updates.push(`${col} = $${idx++}`);
    values.push(value);
  };

  if (input.handle !== undefined) push('handle', input.handle);
  if (input.name !== undefined) push('name', input.name);
  if (input.description !== undefined) push('description', input.description);
  if (input.allow_insecure_tls !== undefined)
    push('allow_insecure_tls', input.allow_insecure_tls);

  if (updates.length === 0) return existing;

  values.push(id);
  const row = await querySingle<KapiCollection>(
    `UPDATE kapi.collections SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (!row) throw new KapiError(404, 'Collection not found');
  return row;
}

export async function deleteCollection(id: string): Promise<void> {
  const result = await query<{ id: string }>(
    `DELETE FROM kapi.collections WHERE id = $1 RETURNING id`,
    [id]
  );
  if (result.length === 0) throw new KapiError(404, 'Collection not found');
}
