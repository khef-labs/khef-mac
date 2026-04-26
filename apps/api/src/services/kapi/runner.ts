/**
 * kapi request runner.
 *
 * Variable interpolation + pre-script hook + undici fetch with manual redirect
 * handling + test-script hook + insert into kapi.runs. Pre/test scripts run
 * inside an isolated-vm sandbox (see sandbox.ts). Env var writes from scripts
 * are persisted back to the active environment between runs.
 */

import { Agent, request as undiciRequest } from 'undici';
import { query, querySingle } from '../../db/client';
import { KapiError } from './definitions';
import { resolveEnvValues, upsertEnvVar } from './environments';
import { getRequestById } from './requests';
import { getDefinitionById } from './definitions';
import { runPreScript, runTestScript, type TestResult } from './sandbox';
import type {
  KapiAuthConfig,
  KapiHttpMethod,
  KapiKeyValue,
  KapiRun,
  KapiScriptLanguage,
} from './types';

const MAX_BODY_CAPTURE = 1_000_000; // 1 MB
const DEFAULT_TIMEOUT_MS = 30_000;

const secureAgent = new Agent();
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

const SECRET_HEADER_PATTERNS = [
  /authorization/i,
  /cookie/i,
  /x-api-key/i,
  /api-key/i,
  /proxy-authorization/i,
];

function interpolate(input: string, vars: Record<string, string>): string {
  return input.replace(/{{\s*([\w.-]+)\s*}}/g, (_, key) => {
    return vars[key] !== undefined ? vars[key] : `{{${key}}}`;
  });
}

function applyAuth(
  auth: KapiAuthConfig | null | undefined,
  vars: Record<string, string>,
  headers: KapiKeyValue[]
): KapiKeyValue[] {
  if (!auth || auth.kind === 'none') return headers;
  const out = [...headers];
  if (auth.kind === 'bearer' && auth.tokenVar) {
    const token = vars[auth.tokenVar];
    if (token) out.push({ key: 'Authorization', value: `Bearer ${token}`, enabled: true });
  } else if (auth.kind === 'basic' && auth.username && auth.passwordVar) {
    const pass = vars[auth.passwordVar] ?? '';
    const encoded = Buffer.from(`${auth.username}:${pass}`).toString('base64');
    out.push({ key: 'Authorization', value: `Basic ${encoded}`, enabled: true });
  } else if (auth.kind === 'api-key' && auth.headerName && auth.tokenVar) {
    const token = vars[auth.tokenVar];
    if (token) out.push({ key: auth.headerName, value: token, enabled: true });
  }
  return out;
}

function kvArrayToHeadersObject(kv: KapiKeyValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of kv) {
    if (!item.enabled) continue;
    if (!item.key) continue;
    out[item.key] = item.value ?? '';
  }
  return out;
}

function headersObjectToKvArray(obj: Record<string, string>): KapiKeyValue[] {
  return Object.entries(obj).map(([key, value]) => ({
    key,
    value: value ?? '',
    enabled: true,
  }));
}

function buildUrl(
  baseUrl: string | null | undefined,
  path: string,
  queryParams: KapiKeyValue[]
): string {
  // If path is already absolute (e.g. definition-less ad-hoc override),
  // skip the base_url join. Prevents `basehttp://…` concatenations.
  const isAbsolute = /^https?:\/\//i.test(path);
  const base = (baseUrl ?? '').replace(/\/$/, '');
  let url: string;
  if (isAbsolute) {
    url = path;
  } else {
    const p = path.startsWith('/') || !base ? path : `/${path}`;
    url = base ? `${base}${p}` : p;
  }
  const enabled = queryParams.filter((q) => q.enabled && q.key);
  if (enabled.length === 0) return url;
  const search = enabled
    .map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value ?? '')}`)
    .join('&');
  return url.includes('?') ? `${url}&${search}` : `${url}?${search}`;
}

function redactHeaders(headers: KapiKeyValue[]): KapiKeyValue[] {
  return headers.map((h) => {
    if (SECRET_HEADER_PATTERNS.some((re) => re.test(h.key))) {
      return { ...h, value: '***redacted***' };
    }
    return h;
  });
}

function redactResponseHeaders(
  headers: Array<[string, string]>
): Array<[string, string]> {
  return headers.map(([k, v]) =>
    SECRET_HEADER_PATTERNS.some((re) => re.test(k)) ? [k, '***redacted***'] : [k, v]
  );
}

interface RunOptions {
  /** If true, use an Agent that accepts self-signed certs. Off by default. */
  allow_insecure_tls?: boolean;
  /** Max redirects to follow. Default 0 (manual — surfaces 3xx to caller). */
  max_redirects?: number;
  /** Override timeout in ms. */
  timeout_ms?: number;
  /**
   * Aborts the upstream undici call and sandbox fetches. Wire this from the
   * Fastify route's request.raw `close` event so client disconnects stop
   * in-flight work instead of racing to completion.
   */
  signal?: AbortSignal;
}

export interface RunResult extends KapiRun {}

/**
 * Execute a request that's already saved in the DB.
 */
export async function runSavedRequest(
  requestId: string,
  options: RunOptions = {}
): Promise<RunResult> {
  const req = await getRequestById(requestId);
  if (!req) throw new KapiError(404, 'Request not found');
  const def = await getDefinitionById(req.definition_id);
  if (!def) throw new KapiError(404, 'Definition not found');

  const activeEnv = await querySingle<{ id: string; collection_id: string }>(
    `SELECT id, collection_id FROM kapi.environments
     WHERE collection_id = $1 AND is_active = TRUE
     LIMIT 1`,
    [def.collection_id]
  );
  const envVars = activeEnv ? await resolveEnvValues(activeEnv.id) : {};

  const preScript: InlineScript | null = req.pre_script_content
    ? { content: req.pre_script_content, language: req.pre_script_language }
    : null;
  const testScript: InlineScript | null = req.test_script_content
    ? { content: req.test_script_content, language: req.test_script_language }
    : null;

  // If the caller didn't explicitly pass allow_insecure_tls, fall back to
  // the collection's stored preference so the toggle survives devices /
  // sessions without the UI always having to resend it.
  const resolvedOptions: RunOptions = { ...options };
  if (resolvedOptions.allow_insecure_tls === undefined) {
    const row = await querySingle<{ allow_insecure_tls: boolean }>(
      `SELECT allow_insecure_tls FROM kapi.collections WHERE id = $1`,
      [def.collection_id]
    );
    resolvedOptions.allow_insecure_tls = row?.allow_insecure_tls ?? false;
  }

  // Interpolate param key/value BEFORE buildUrl encodes them. If we encoded
  // first and then ran interpolate over the final URL string, any {{var}}
  // placeholder inside a param value would have been URL-encoded to
  // %7B%7Bvar%7D%7D and the interpolate regex would never match — the
  // server would receive literal '{{var}}' on the wire.
  const interpolatedQueryParams = req.query_params.map((q) => ({
    ...q,
    key: interpolate(q.key ?? '', envVars),
    value: interpolate(q.value ?? '', envVars),
  }));

  return executeAndRecord({
    collectionId: def.collection_id,
    requestId: req.id,
    definitionId: def.id,
    environmentId: activeEnv?.id ?? null,
    method: req.method,
    url: interpolate(
      buildUrl(def.base_url, req.path, interpolatedQueryParams),
      envVars
    ),
    headers: applyAuth(
      req.auth_override ?? def.default_auth,
      envVars,
      req.headers
    ).map((h) => ({
      ...h,
      value: interpolate(h.value ?? '', envVars),
    })),
    body: req.body_type === 'none' ? null : interpolate(req.body_content, envVars),
    envValues: envVars,
    preScript,
    testScript,
    options: resolvedOptions,
  });
}

export interface AdHocRunInput {
  collection_id: string;
  method: KapiHttpMethod;
  url: string;
  headers?: KapiKeyValue[];
  body?: string | null;
  environment_id?: string | null;
  options?: RunOptions;
}

export async function runAdHoc(input: AdHocRunInput): Promise<RunResult> {
  const envVars = input.environment_id
    ? await resolveEnvValues(input.environment_id)
    : {};
  return executeAndRecord({
    collectionId: input.collection_id,
    requestId: null,
    definitionId: null,
    environmentId: input.environment_id ?? null,
    method: input.method,
    url: interpolate(input.url, envVars),
    headers: (input.headers ?? []).map((h) => ({
      ...h,
      value: interpolate(h.value ?? '', envVars),
    })),
    body: input.body ? interpolate(input.body, envVars) : null,
    envValues: envVars,
    preScript: null,
    testScript: null,
    options: input.options ?? {},
  });
}

interface InlineScript {
  content: string;
  language: KapiScriptLanguage;
}

interface ExecuteInput {
  collectionId: string;
  requestId: string | null;
  definitionId: string | null;
  environmentId: string | null;
  method: KapiHttpMethod;
  url: string;
  headers: KapiKeyValue[];
  body: string | null;
  envValues: Record<string, string>;
  preScript: InlineScript | null;
  testScript: InlineScript | null;
  options: RunOptions;
}

async function executeAndRecord(input: ExecuteInput): Promise<RunResult> {
  let method: KapiHttpMethod = input.method;
  let url = input.url;
  let headers: KapiKeyValue[] = input.headers;
  let body: string | null = input.body;

  let preScriptLog: string | null = null;
  let preScriptError: string | null = null;
  let preScriptEnvWrites: Record<string, string> | null = null;

  // --- Pre-script ---
  if (input.preScript && input.preScript.language === 'javascript') {
    const pre = await runPreScript(input.preScript.content, {
      request: {
        method,
        url,
        headers: kvArrayToHeadersObject(headers),
        body,
      },
      env: input.envValues,
      allowInsecureTls: input.options.allow_insecure_tls,
      signal: input.options.signal,
    });
    // Apply mutations. Method is validated against the whitelist; an invalid
    // override is ignored so a script can't send arbitrary verbs.
    if (isHttpMethod(pre.request.method)) method = pre.request.method;
    url = pre.request.url;
    headers = headersObjectToKvArray(pre.request.headers);
    body = pre.request.body;
    preScriptEnvWrites = pre.env_writes ?? null;
    preScriptLog = pre.log || null;
    preScriptError = pre.error;
  }

  const startedAt = Date.now();
  let responseStatus: number | null = null;
  let responseHeaders: Array<[string, string]> | null = null;
  let responseBody: string | null = null;
  let httpErrorMessage: string | null = null;

  try {
    const headersObj = kvArrayToHeadersObject(headers);
    const dispatcher = input.options.allow_insecure_tls ? insecureAgent : secureAgent;
    // undici.request does not follow redirects by default — 3xx surfaces to
    // the caller. This sidesteps the known undici redirect-leakage CVE class
    // and is the desired behavior for a pen-testing tool anyway. To opt into
    // following redirects, a RedirectHandler interceptor will be added to the
    // dispatcher in a follow-up.
    const res = await undiciRequest(url, {
      method,
      headers: headersObj,
      body: body ?? undefined,
      dispatcher,
      headersTimeout: input.options.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      bodyTimeout: input.options.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      signal: input.options.signal,
    });

    responseStatus = res.statusCode;

    const hdrEntries: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(res.headers)) {
      if (Array.isArray(v)) hdrEntries.push([k, v.join(', ')]);
      else if (v !== undefined) hdrEntries.push([k, String(v)]);
    }
    responseHeaders = redactResponseHeaders(hdrEntries);

    responseBody = await readCappedBody(res.body);
  } catch (err) {
    if (input.options.signal?.aborted) {
      httpErrorMessage = 'Canceled';
    } else {
      httpErrorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  const elapsedMs = Date.now() - startedAt;

  // --- Test script ---
  let testScriptLog: string | null = null;
  let testScriptError: string | null = null;
  let testScriptEnvWrites: Record<string, string> | null = null;
  let testResults: TestResult[] | null = null;

  if (
    input.testScript &&
    input.testScript.language === 'javascript' &&
    responseStatus !== null
  ) {
    const responseHeadersObj: Record<string, string> = {};
    for (const [k, v] of responseHeaders ?? []) responseHeadersObj[k] = v;
    const test = await runTestScript(input.testScript.content, {
      request: {
        method,
        url,
        headers: kvArrayToHeadersObject(headers),
        body,
      },
      response: {
        status: responseStatus,
        headers: responseHeadersObj,
        body: responseBody,
      },
      env: input.envValues,
      allowInsecureTls: input.options.allow_insecure_tls,
      signal: input.options.signal,
    });
    testScriptEnvWrites = test.env_writes ?? null;
    testScriptLog = test.log || null;
    testScriptError = test.error;
    testResults = test.test_results;
  }

  // --- Persist env writes to the active environment (plaintext only) ---
  const mergedEnvWrites: Record<string, string> = {
    ...(preScriptEnvWrites ?? {}),
    ...(testScriptEnvWrites ?? {}),
  };
  if (input.environmentId && Object.keys(mergedEnvWrites).length > 0) {
    for (const [key, value] of Object.entries(mergedEnvWrites)) {
      try {
        await upsertEnvVar(input.environmentId, {
          key,
          value,
          is_secret: false,
        });
      } catch {
        // Swallow — don't fail the run because a script tried to write an
        // invalid key. The error lives in the script log if the caller needs
        // to debug.
      }
    }
  }

  // Top-level `error` is the HTTP transport error only — script errors now
  // live in their own columns so the UI can render them distinctly.
  const topLevelError = httpErrorMessage;

  const run = await querySingle<KapiRun>(
    `INSERT INTO kapi.runs
       (collection_id, request_id, definition_id, environment_id,
        resolved_method, resolved_url, resolved_headers, resolved_body,
        response_status, response_headers, response_body, response_time_ms,
        pre_script_log, test_script_log,
        pre_script_error, test_script_error,
        pre_script_env_writes, test_script_env_writes,
        test_results, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING *`,
    [
      input.collectionId,
      input.requestId,
      input.definitionId,
      input.environmentId,
      method,
      url,
      JSON.stringify(redactHeaders(headers)),
      body,
      responseStatus,
      responseHeaders ? JSON.stringify(responseHeaders) : null,
      responseBody,
      elapsedMs,
      preScriptLog,
      testScriptLog,
      preScriptError,
      testScriptError,
      preScriptEnvWrites ? JSON.stringify(preScriptEnvWrites) : null,
      testScriptEnvWrites ? JSON.stringify(testScriptEnvWrites) : null,
      testResults ? JSON.stringify(testResults) : null,
      topLevelError || null,
    ]
  );

  if (!run) throw new KapiError(500, 'Failed to record run');
  return run;
}

const HTTP_METHODS = new Set<KapiHttpMethod>([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);
function isHttpMethod(value: string): value is KapiHttpMethod {
  return HTTP_METHODS.has(value as KapiHttpMethod);
}

async function readCappedBody(
  stream: import('undici').Dispatcher.ResponseData['body']
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_CAPTURE) {
      chunks.push(buf.subarray(0, MAX_BODY_CAPTURE - (total - buf.length)));
      // drain the rest without buffering
      for await (const _ of stream) { /* drain */ }
      break;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function listRuns(
  collectionId: string,
  filters?: { request_id?: string; limit?: number }
): Promise<KapiRun[]> {
  const clauses: string[] = ['collection_id = $1'];
  const params: unknown[] = [collectionId];
  if (filters?.request_id) {
    clauses.push(`request_id = $${params.length + 1}`);
    params.push(filters.request_id);
  }
  const limit = Math.min(Math.max(filters?.limit ?? 50, 1), 500);
  params.push(limit);

  return query<KapiRun>(
    `SELECT id, collection_id, request_id, definition_id, environment_id,
            resolved_method, resolved_url, resolved_headers,
            response_status, response_time_ms, error, executed_at
     FROM kapi.runs
     WHERE ${clauses.join(' AND ')}
     ORDER BY executed_at DESC
     LIMIT $${params.length}`,
    params
  );
}

export async function getRun(id: string): Promise<KapiRun | null> {
  return querySingle<KapiRun>(`SELECT * FROM kapi.runs WHERE id = $1`, [id]);
}
