import { query, querySingle, getClient } from '../../db/client';
import { KapiError } from './definitions';
import { decryptSecret, encryptSecret, isSecretKeyConfigured } from './secrets';
import type { KapiEnvVar, KapiEnvironment } from './types';

const HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface CreateEnvironmentInput {
  collection_id: string;
  handle: string;
  name: string;
  is_active?: boolean;
}

export interface UpdateEnvironmentInput {
  handle?: string;
  name?: string;
}

export interface UpsertEnvVarInput {
  key: string;
  value: string;
  is_secret?: boolean;
  description?: string | null;
}

export async function listEnvironments(collectionId: string): Promise<KapiEnvironment[]> {
  return query<KapiEnvironment>(
    `SELECT * FROM kapi.environments
     WHERE collection_id = $1
     ORDER BY is_active DESC, updated_at DESC`,
    [collectionId]
  );
}

export async function getEnvironmentById(id: string): Promise<KapiEnvironment | null> {
  return querySingle<KapiEnvironment>(
    `SELECT * FROM kapi.environments WHERE id = $1`,
    [id]
  );
}

export async function createEnvironment(
  input: CreateEnvironmentInput
): Promise<KapiEnvironment> {
  if (!HANDLE_RE.test(input.handle)) {
    throw new KapiError(400, `Invalid handle: "${input.handle}" (must be kebab-case)`);
  }
  if (!input.name?.trim()) throw new KapiError(400, 'name is required');

  const existing = await querySingle<{ id: string }>(
    `SELECT id FROM kapi.environments WHERE collection_id = $1 AND handle = $2`,
    [input.collection_id, input.handle]
  );
  if (existing) {
    throw new KapiError(409, `Environment "${input.handle}" already exists in this collection`);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    if (input.is_active) {
      await client.query(
        `UPDATE kapi.environments SET is_active = FALSE WHERE collection_id = $1`,
        [input.collection_id]
      );
    }
    const result = await client.query<KapiEnvironment>(
      `INSERT INTO kapi.environments (collection_id, handle, name, is_active)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [input.collection_id, input.handle, input.name, input.is_active ?? false]
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

export async function updateEnvironment(
  id: string,
  input: UpdateEnvironmentInput
): Promise<KapiEnvironment> {
  const existing = await getEnvironmentById(id);
  if (!existing) throw new KapiError(404, 'Environment not found');

  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  const push = (col: string, v: unknown) => {
    updates.push(`${col} = $${idx++}`);
    values.push(v);
  };

  if (input.handle !== undefined) {
    if (!HANDLE_RE.test(input.handle)) {
      throw new KapiError(400, `Invalid handle: "${input.handle}"`);
    }
    push('handle', input.handle);
  }
  if (input.name !== undefined) push('name', input.name);

  if (updates.length === 0) return existing;

  values.push(id);
  const row = await querySingle<KapiEnvironment>(
    `UPDATE kapi.environments SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (!row) throw new KapiError(404, 'Environment not found');
  return row;
}

export async function deleteEnvironment(id: string): Promise<void> {
  const result = await query<{ id: string }>(
    `DELETE FROM kapi.environments WHERE id = $1 RETURNING id`,
    [id]
  );
  if (result.length === 0) throw new KapiError(404, 'Environment not found');
}

export async function activateEnvironment(id: string): Promise<KapiEnvironment> {
  const env = await getEnvironmentById(id);
  if (!env) throw new KapiError(404, 'Environment not found');

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE kapi.environments SET is_active = FALSE WHERE collection_id = $1 AND id <> $2`,
      [env.collection_id, id]
    );
    const result = await client.query<KapiEnvironment>(
      `UPDATE kapi.environments SET is_active = TRUE WHERE id = $1 RETURNING *`,
      [id]
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

/**
 * Row returned to clients — secret values are redacted.
 * Used by all listing/read endpoints and MCP tools.
 */
export interface RedactedEnvVar extends Omit<KapiEnvVar, 'value'> {
  value: string | null;
}

function redactRow(row: KapiEnvVar & { secret_ciphertext?: Buffer | null }): RedactedEnvVar {
  const { secret_ciphertext, ...rest } = row;
  return {
    ...rest,
    value: row.is_secret ? '***redacted***' : (row.value ?? null),
  };
}

export async function listEnvVars(environmentId: string): Promise<RedactedEnvVar[]> {
  const rows = await query<KapiEnvVar & { secret_ciphertext: Buffer | null }>(
    `SELECT id, environment_id, key, value, secret_ciphertext, is_secret,
            description, created_at, updated_at
     FROM kapi.env_vars
     WHERE environment_id = $1
     ORDER BY key`,
    [environmentId]
  );
  return rows.map(redactRow);
}

/**
 * Internal lookup returning decrypted values. Used by the runner only.
 */
export async function resolveEnvValues(
  environmentId: string
): Promise<Record<string, string>> {
  const rows = await query<{
    key: string;
    value: string | null;
    secret_ciphertext: Buffer | null;
    is_secret: boolean;
  }>(
    `SELECT key, value, secret_ciphertext, is_secret FROM kapi.env_vars WHERE environment_id = $1`,
    [environmentId]
  );
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.is_secret) {
      if (!r.secret_ciphertext) continue;
      out[r.key] = decryptSecret(r.secret_ciphertext);
    } else if (r.value !== null) {
      out[r.key] = r.value;
    }
  }
  return out;
}

export async function upsertEnvVar(
  environmentId: string,
  input: UpsertEnvVarInput
): Promise<RedactedEnvVar> {
  if (!input.key?.trim()) throw new KapiError(400, 'key is required');
  if (input.is_secret && !isSecretKeyConfigured()) {
    throw new KapiError(
      500,
      'Cannot store secret — KAPI_SECRET_KEY is not configured. Generate one with: openssl rand -base64 32'
    );
  }

  const isSecret = !!input.is_secret;
  const plaintext = input.value ?? '';
  const ciphertext = isSecret ? encryptSecret(plaintext) : null;
  const storedValue = isSecret ? null : plaintext;

  const row = await querySingle<KapiEnvVar & { secret_ciphertext: Buffer | null }>(
    `INSERT INTO kapi.env_vars
       (environment_id, key, value, secret_ciphertext, is_secret, description)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (environment_id, key) DO UPDATE SET
       value = EXCLUDED.value,
       secret_ciphertext = EXCLUDED.secret_ciphertext,
       is_secret = EXCLUDED.is_secret,
       description = EXCLUDED.description,
       updated_at = NOW()
     RETURNING *`,
    [environmentId, input.key, storedValue, ciphertext, isSecret, input.description ?? null]
  );
  if (!row) throw new KapiError(500, 'Failed to upsert env var');
  return redactRow(row);
}

export async function deleteEnvVar(environmentId: string, key: string): Promise<void> {
  const result = await query<{ id: string }>(
    `DELETE FROM kapi.env_vars WHERE environment_id = $1 AND key = $2 RETURNING id`,
    [environmentId, key]
  );
  if (result.length === 0) throw new KapiError(404, 'Env var not found');
}

/**
 * Rename an env var in place. Keeps value / ciphertext / is_secret /
 * description untouched — only the key changes. Conflicts (new_key already
 * exists in this environment) surface as 409.
 */
export async function renameEnvVar(
  environmentId: string,
  oldKey: string,
  newKey: string
): Promise<RedactedEnvVar> {
  if (!newKey?.trim()) throw new KapiError(400, 'new_key is required');
  if (oldKey === newKey) {
    const existing = await querySingle<
      KapiEnvVar & { secret_ciphertext: Buffer | null }
    >(
      `SELECT * FROM kapi.env_vars WHERE environment_id = $1 AND key = $2`,
      [environmentId, oldKey]
    );
    if (!existing) throw new KapiError(404, 'Env var not found');
    return redactRow(existing);
  }

  // Pre-check for collision so the error message is clear. The unique
  // constraint would also catch it, but with a generic 23505 message.
  const conflict = await querySingle<{ id: string }>(
    `SELECT id FROM kapi.env_vars WHERE environment_id = $1 AND key = $2`,
    [environmentId, newKey]
  );
  if (conflict) {
    throw new KapiError(
      409,
      `Env var "${newKey}" already exists in this environment`
    );
  }

  const row = await querySingle<KapiEnvVar & { secret_ciphertext: Buffer | null }>(
    `UPDATE kapi.env_vars SET key = $3, updated_at = NOW()
     WHERE environment_id = $1 AND key = $2
     RETURNING *`,
    [environmentId, oldKey, newKey]
  );
  if (!row) throw new KapiError(404, 'Env var not found');
  return redactRow(row);
}
