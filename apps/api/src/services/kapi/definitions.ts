import { query, querySingle, getClient } from '../../db/client';
import type { KapiAuthConfig, KapiDefinition } from './types';

const HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class KapiError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export interface CreateDefinitionInput {
  collection_id: string;
  handle: string;
  name: string;
  description?: string | null;
  base_url?: string | null;
  default_auth?: KapiAuthConfig;
  openapi_source?: string | null;
}

export interface UpdateDefinitionInput {
  handle?: string;
  name?: string;
  description?: string | null;
  base_url?: string | null;
  default_auth?: KapiAuthConfig;
  openapi_source?: string | null;
}

function validateHandle(handle: string): void {
  if (!HANDLE_RE.test(handle)) {
    throw new KapiError(400, `Invalid handle: "${handle}" (must be kebab-case)`);
  }
  if (handle.length > 100) {
    throw new KapiError(400, 'Handle exceeds 100 characters');
  }
}

export async function listDefinitions(collectionId: string): Promise<KapiDefinition[]> {
  return query<KapiDefinition>(
    `SELECT * FROM kapi.definitions
     WHERE collection_id = $1
     ORDER BY updated_at DESC`,
    [collectionId]
  );
}

export async function getDefinitionById(id: string): Promise<KapiDefinition | null> {
  return querySingle<KapiDefinition>(
    `SELECT * FROM kapi.definitions WHERE id = $1`,
    [id]
  );
}

export async function getDefinitionByHandle(
  collectionId: string,
  handle: string
): Promise<KapiDefinition | null> {
  return querySingle<KapiDefinition>(
    `SELECT * FROM kapi.definitions WHERE collection_id = $1 AND handle = $2`,
    [collectionId, handle]
  );
}

export async function createDefinition(input: CreateDefinitionInput): Promise<KapiDefinition> {
  validateHandle(input.handle);
  if (!input.name?.trim()) {
    throw new KapiError(400, 'name is required');
  }

  const existing = await getDefinitionByHandle(input.collection_id, input.handle);
  if (existing) {
    throw new KapiError(409, `Definition "${input.handle}" already exists in this collection`);
  }

  const row = await querySingle<KapiDefinition>(
    `INSERT INTO kapi.definitions
       (collection_id, handle, name, description, base_url, default_auth, openapi_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.collection_id,
      input.handle,
      input.name,
      input.description ?? null,
      input.base_url ?? null,
      JSON.stringify(input.default_auth ?? { kind: 'none' }),
      input.openapi_source ?? null,
    ]
  );

  if (!row) throw new KapiError(500, 'Failed to create definition');
  return row;
}

export async function updateDefinition(
  id: string,
  input: UpdateDefinitionInput
): Promise<KapiDefinition> {
  const existing = await getDefinitionById(id);
  if (!existing) throw new KapiError(404, 'Definition not found');

  if (input.handle !== undefined && input.handle !== existing.handle) {
    validateHandle(input.handle);
    const conflict = await getDefinitionByHandle(existing.collection_id, input.handle);
    if (conflict) {
      throw new KapiError(409, `Definition "${input.handle}" already exists in this collection`);
    }
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
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
    if (input.base_url !== undefined) push('base_url', input.base_url);
    if (input.default_auth !== undefined) push('default_auth', JSON.stringify(input.default_auth));
    if (input.openapi_source !== undefined) push('openapi_source', input.openapi_source);

    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return existing;
    }

    values.push(id);
    const result = await client.query(
      `UPDATE kapi.definitions SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteDefinition(id: string): Promise<void> {
  const result = await query<{ id: string }>(
    `DELETE FROM kapi.definitions WHERE id = $1 RETURNING id`,
    [id]
  );
  if (result.length === 0) throw new KapiError(404, 'Definition not found');
}
