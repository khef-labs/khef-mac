import { query, querySingle, getClient } from '../../db/client';
import { KapiError } from './definitions';
import type {
  KapiAuthConfig,
  KapiBodyLanguage,
  KapiBodyType,
  KapiHttpMethod,
  KapiKeyValue,
  KapiRequest,
  KapiScriptLanguage,
} from './types';

const METHODS: readonly KapiHttpMethod[] = [
  'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS',
];
const BODY_TYPES: readonly KapiBodyType[] = [
  'none', 'raw', 'form-data', 'x-www-form', 'binary', 'graphql',
];
const BODY_LANGUAGES: readonly KapiBodyLanguage[] = [
  'json', 'xml', 'text', 'graphql', 'html', 'yaml',
];
const SCRIPT_LANGUAGES: readonly KapiScriptLanguage[] = ['javascript', 'shell'];

export interface CreateRequestInput {
  definition_id: string;
  folder_id?: string | null;
  name: string;
  method: KapiHttpMethod;
  path?: string;
  query_params?: KapiKeyValue[];
  headers?: KapiKeyValue[];
  body_type?: KapiBodyType;
  body_content?: string;
  body_language?: KapiBodyLanguage;
  auth_override?: KapiAuthConfig | null;
  pre_script_content?: string;
  pre_script_language?: KapiScriptLanguage;
  test_script_content?: string;
  test_script_language?: KapiScriptLanguage;
  order_index?: number;
}

export interface UpdateRequestInput {
  folder_id?: string | null;
  name?: string;
  method?: KapiHttpMethod;
  path?: string;
  query_params?: KapiKeyValue[];
  headers?: KapiKeyValue[];
  body_type?: KapiBodyType;
  body_content?: string;
  body_language?: KapiBodyLanguage;
  auth_override?: KapiAuthConfig | null;
  pre_script_content?: string;
  pre_script_language?: KapiScriptLanguage;
  test_script_content?: string;
  test_script_language?: KapiScriptLanguage;
  order_index?: number;
}

function validateMethod(method: string): asserts method is KapiHttpMethod {
  if (!METHODS.includes(method as KapiHttpMethod)) {
    throw new KapiError(400, `Invalid method: "${method}"`);
  }
}

function validateBodyType(bodyType: string): asserts bodyType is KapiBodyType {
  if (!BODY_TYPES.includes(bodyType as KapiBodyType)) {
    throw new KapiError(400, `Invalid body_type: "${bodyType}"`);
  }
}

function validateBodyLanguage(lang: string): asserts lang is KapiBodyLanguage {
  if (!BODY_LANGUAGES.includes(lang as KapiBodyLanguage)) {
    throw new KapiError(400, `Invalid body_language: "${lang}"`);
  }
}

function validateScriptLanguage(
  lang: string,
  label: 'pre_script_language' | 'test_script_language'
): asserts lang is KapiScriptLanguage {
  if (!SCRIPT_LANGUAGES.includes(lang as KapiScriptLanguage)) {
    throw new KapiError(400, `Invalid ${label}: "${lang}"`);
  }
}

export async function listRequests(definitionId: string): Promise<KapiRequest[]> {
  return query<KapiRequest>(
    `SELECT * FROM kapi.requests
     WHERE definition_id = $1
     ORDER BY order_index, created_at`,
    [definitionId]
  );
}

export async function getRequestById(id: string): Promise<KapiRequest | null> {
  return querySingle<KapiRequest>(`SELECT * FROM kapi.requests WHERE id = $1`, [id]);
}

export async function createRequest(input: CreateRequestInput): Promise<KapiRequest> {
  if (!input.name?.trim()) throw new KapiError(400, 'name is required');
  validateMethod(input.method);
  if (input.body_type) validateBodyType(input.body_type);
  if (input.body_language) validateBodyLanguage(input.body_language);

  if (input.pre_script_language) {
    validateScriptLanguage(input.pre_script_language, 'pre_script_language');
  }
  if (input.test_script_language) {
    validateScriptLanguage(input.test_script_language, 'test_script_language');
  }

  const row = await querySingle<KapiRequest>(
    `INSERT INTO kapi.requests
       (definition_id, folder_id, name, method, path, query_params, headers,
        body_type, body_content, body_language, auth_override,
        pre_script_content, pre_script_language,
        test_script_content, test_script_language,
        order_index)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      input.definition_id,
      input.folder_id ?? null,
      input.name,
      input.method,
      input.path ?? '',
      JSON.stringify(input.query_params ?? []),
      JSON.stringify(input.headers ?? []),
      input.body_type ?? 'none',
      input.body_content ?? '',
      input.body_language ?? 'text',
      input.auth_override ? JSON.stringify(input.auth_override) : null,
      input.pre_script_content ?? '',
      input.pre_script_language ?? 'javascript',
      input.test_script_content ?? '',
      input.test_script_language ?? 'javascript',
      input.order_index ?? 0,
    ]
  );
  if (!row) throw new KapiError(500, 'Failed to create request');
  return row;
}

export async function updateRequest(
  id: string,
  input: UpdateRequestInput
): Promise<KapiRequest> {
  const existing = await getRequestById(id);
  if (!existing) throw new KapiError(404, 'Request not found');

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

    if (input.folder_id !== undefined) push('folder_id', input.folder_id);
    if (input.name !== undefined) push('name', input.name);
    if (input.method !== undefined) {
      validateMethod(input.method);
      push('method', input.method);
    }
    if (input.path !== undefined) push('path', input.path);
    if (input.query_params !== undefined) push('query_params', JSON.stringify(input.query_params));
    if (input.headers !== undefined) push('headers', JSON.stringify(input.headers));
    if (input.body_type !== undefined) {
      validateBodyType(input.body_type);
      push('body_type', input.body_type);
    }
    if (input.body_content !== undefined) push('body_content', input.body_content);
    if (input.body_language !== undefined) {
      validateBodyLanguage(input.body_language);
      push('body_language', input.body_language);
    }
    if (input.auth_override !== undefined) {
      push('auth_override', input.auth_override ? JSON.stringify(input.auth_override) : null);
    }
    if (input.pre_script_content !== undefined) {
      push('pre_script_content', input.pre_script_content);
    }
    if (input.pre_script_language !== undefined) {
      validateScriptLanguage(input.pre_script_language, 'pre_script_language');
      push('pre_script_language', input.pre_script_language);
    }
    if (input.test_script_content !== undefined) {
      push('test_script_content', input.test_script_content);
    }
    if (input.test_script_language !== undefined) {
      validateScriptLanguage(input.test_script_language, 'test_script_language');
      push('test_script_language', input.test_script_language);
    }
    if (input.order_index !== undefined) push('order_index', input.order_index);

    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return existing;
    }

    values.push(id);
    const result = await client.query(
      `UPDATE kapi.requests SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
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

export async function deleteRequest(id: string): Promise<void> {
  const result = await query<{ id: string }>(
    `DELETE FROM kapi.requests WHERE id = $1 RETURNING id`,
    [id]
  );
  if (result.length === 0) throw new KapiError(404, 'Request not found');
}
