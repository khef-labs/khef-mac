/**
 * kapi pre/test script sandbox.
 *
 * Runs user-authored JavaScript inside an isolated-vm V8 isolate with a
 * curated `khef.*` host API plus Postman-like top-level ergonomics:
 *   - `env.foo` / `env.foo = 'x'`  (proxy over the snapshot)
 *   - `setEnv(k, v)` / `getEnv(k)`
 *   - `console.log(...)`  (aliased to khef.log)
 *   - `fetch(url, opts)`  (host-bridged undici call; short timeout)
 *
 * Scripts cannot reach Node built-ins or the file system. `fetch` lets a
 * script do OAuth-style prefetches (e.g. grab a token before the main
 * request), and `khef.jwt.sign` wraps jsonwebtoken so scripts can mint
 * tokens without access to key material.
 *
 * Limits: 128 MB per isolate, 5 s wall clock per script.
 */

import { Agent, request as undiciRequest } from 'undici';
import ivm from 'isolated-vm';
import jwt from 'jsonwebtoken';

const MEMORY_LIMIT_MB = 128;
const SCRIPT_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_BODY_CAP = 1_000_000;

const sandboxFetchAgent = new Agent();
const sandboxInsecureFetchAgent = new Agent({
  connect: { rejectUnauthorized: false },
});

export interface SandboxRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface SandboxResponse {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

export interface TestResult {
  name: string;
  pass: boolean;
  error?: string;
}

export interface SandboxResult {
  request: SandboxRequest;
  env_writes: Record<string, string>;
  log: string;
  test_results: TestResult[];
  error: string | null;
}

interface SandboxInput {
  userCode: string;
  request: SandboxRequest;
  response: SandboxResponse | null;
  env: Record<string, string>;
  allowInsecureTls?: boolean;
  /** Aborts any host-bridged fetch inside the script. */
  signal?: AbortSignal;
}

export async function runPreScript(
  content: string,
  ctx: {
    request: SandboxRequest;
    env: Record<string, string>;
    allowInsecureTls?: boolean;
    signal?: AbortSignal;
  }
): Promise<SandboxResult> {
  return execute({
    userCode: content,
    request: ctx.request,
    response: null,
    env: ctx.env,
    allowInsecureTls: ctx.allowInsecureTls,
    signal: ctx.signal,
  });
}

export async function runTestScript(
  content: string,
  ctx: {
    request: SandboxRequest;
    response: SandboxResponse;
    env: Record<string, string>;
    allowInsecureTls?: boolean;
    signal?: AbortSignal;
  }
): Promise<SandboxResult> {
  return execute({
    userCode: content,
    request: ctx.request,
    response: ctx.response,
    env: ctx.env,
    allowInsecureTls: ctx.allowInsecureTls,
    signal: ctx.signal,
  });
}

async function execute(input: SandboxInput): Promise<SandboxResult> {
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  try {
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set('global', jail.derefInto());

    // Only host bridge. Signs JWTs with node:crypto since the isolate has no
    // crypto primitives. Payload and options are transferred as JSON strings
    // to sidestep ExternalCopy on arbitrary user objects.
    const jwtSignRef = new ivm.Reference(
      (payloadJson: string, optionsJson: string): string => {
        const payload = JSON.parse(payloadJson);
        const raw = JSON.parse(optionsJson) as Record<string, unknown>;
        const { key, alg, ...rest } = raw as {
          key?: string;
          alg?: string;
          [k: string]: unknown;
        };
        if (!key) throw new Error('jwt.sign requires options.key');
        const signOpts = {
          ...rest,
          // Accept either `alg` (the skill-documented name) or `algorithm`
          // (the jsonwebtoken field). Default to HS256 if unspecified.
          algorithm: (alg ?? rest.algorithm ?? 'HS256') as jwt.Algorithm,
        } as jwt.SignOptions;
        return jwt.sign(payload, key, signOpts);
      }
    );
    await jail.set('__jwtSign', jwtSignRef);

    // Host-bridged fetch. Uses undici with default (no) redirect handling
    // to match the main runner's security posture. Timeouts are shorter
    // than the overall run timeout so a slow upstream can't swallow the
    // whole script budget.
    const fetchHostRef = new ivm.Reference(
      async (urlStr: string, optionsJson: string): Promise<string> => {
        const options = JSON.parse(optionsJson) as {
          method?: string;
          headers?: Record<string, string>;
          body?: string;
        };
        const method = (options.method ?? 'GET').toUpperCase();
        const headers = options.headers ?? {};
        const body = options.body !== undefined ? options.body : undefined;
        try {
          const res = await undiciRequest(urlStr, {
            method: method as 'GET',
            headers,
            body,
            dispatcher: input.allowInsecureTls
              ? sandboxInsecureFetchAgent
              : sandboxFetchAgent,
            headersTimeout: FETCH_TIMEOUT_MS,
            bodyTimeout: FETCH_TIMEOUT_MS,
            signal: input.signal,
          });
          const hdrs: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) hdrs[k] = v.join(', ');
            else if (v !== undefined) hdrs[k] = String(v);
          }
          const text = await readCappedBody(res.body, FETCH_BODY_CAP);
          return JSON.stringify({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: hdrs,
            body: text,
          });
        } catch (err) {
          // Propagate as a rejection inside the isolate so user code can
          // catch it (or let it land in __state.runtime_error).
          throw new Error(err instanceof Error ? err.message : String(err));
        }
      }
    );
    await jail.set('__fetchHost', fetchHostRef);

    const initial = {
      request: input.request,
      response: input.response,
      env_snapshot: { ...input.env },
    };
    await jail.set(
      '__initial',
      new ivm.ExternalCopy(initial).copyInto({ release: true })
    );

    const bootstrap = `
      // ---- Minimal URLSearchParams shim ----
      // The isolate has no WHATWG URL built-ins. Covers the 90% case:
      // construct from object / array / string, .set/.get/.has/.append/
      // .delete, and .toString() (x-www-form-urlencoded form).
      function __USP(init) {
        this._entries = [];
        if (init == null) return;
        if (typeof init === 'string') {
          const s = init.charAt(0) === '?' ? init.slice(1) : init;
          if (s) {
            for (const pair of s.split('&')) {
              const eq = pair.indexOf('=');
              if (eq === -1) {
                this._entries.push([decodeURIComponent(pair.replace(/\\+/g, ' ')), '']);
              } else {
                this._entries.push([
                  decodeURIComponent(pair.slice(0, eq).replace(/\\+/g, ' ')),
                  decodeURIComponent(pair.slice(eq + 1).replace(/\\+/g, ' ')),
                ]);
              }
            }
          }
        } else if (Array.isArray(init)) {
          for (const entry of init) {
            if (Array.isArray(entry) && entry.length >= 2) {
              this._entries.push([String(entry[0]), entry[1] == null ? '' : String(entry[1])]);
            }
          }
        } else if (typeof init === 'object') {
          for (const k of Object.keys(init)) {
            this._entries.push([String(k), init[k] == null ? '' : String(init[k])]);
          }
        }
      }
      __USP.prototype.append = function (k, v) {
        this._entries.push([String(k), v == null ? '' : String(v)]);
      };
      __USP.prototype.set = function (k, v) {
        const key = String(k);
        const val = v == null ? '' : String(v);
        let replaced = false;
        const next = [];
        for (const e of this._entries) {
          if (e[0] === key) {
            if (!replaced) { next.push([key, val]); replaced = true; }
          } else {
            next.push(e);
          }
        }
        if (!replaced) next.push([key, val]);
        this._entries = next;
      };
      __USP.prototype.get = function (k) {
        for (const e of this._entries) if (e[0] === String(k)) return e[1];
        return null;
      };
      __USP.prototype.getAll = function (k) {
        const key = String(k);
        const out = [];
        for (const e of this._entries) if (e[0] === key) out.push(e[1]);
        return out;
      };
      __USP.prototype.has = function (k) {
        const key = String(k);
        for (const e of this._entries) if (e[0] === key) return true;
        return false;
      };
      __USP.prototype.delete = function (k) {
        const key = String(k);
        this._entries = this._entries.filter(function (e) { return e[0] !== key; });
      };
      __USP.prototype.toString = function () {
        const enc = function (s) {
          return encodeURIComponent(s).replace(/%20/g, '+');
        };
        return this._entries.map(function (e) { return enc(e[0]) + '=' + enc(e[1]); }).join('&');
      };
      __USP.prototype.forEach = function (cb, thisArg) {
        for (const e of this._entries) cb.call(thisArg, e[1], e[0], this);
      };
      globalThis.URLSearchParams = __USP;

      const __state = {
        request: __initial.request,
        response: __initial.response,
        env_snapshot: __initial.env_snapshot,
        env_writes: {},
        logs: [],
        test_results: [],
        runtime_error: null,
      };

      // Attach Postman-style helpers on khef.request.headers so scripts can
      // do headers.set('Authorization', 'Bearer x') as well as bracket
      // access headers['Authorization'] = '...'. Defined non-enumerable so
      // they don't leak into the JSON readback.
      (function () {
        const h = __state.request.headers;
        Object.defineProperty(h, 'set', {
          enumerable: false,
          value: function (k, v) { this[String(k)] = v == null ? '' : String(v); },
        });
        Object.defineProperty(h, 'get', {
          enumerable: false,
          value: function (k) { return this[String(k)] ?? null; },
        });
        Object.defineProperty(h, 'has', {
          enumerable: false,
          value: function (k) {
            return Object.prototype.hasOwnProperty.call(this, String(k));
          },
        });
        Object.defineProperty(h, 'delete', {
          enumerable: false,
          value: function (k) { delete this[String(k)]; },
        });
        Object.defineProperty(h, 'append', {
          enumerable: false,
          value: function (k, v) { this[String(k)] = v == null ? '' : String(v); },
        });
      })();
      function __stringify(v) {
        if (typeof v === 'string') return v;
        try { return JSON.stringify(v); } catch (_) { return String(v); }
      }
      const khef = Object.freeze({
        request: __state.request,
        response: __state.response,
        env: Object.freeze({
          get(k) {
            const v = __state.env_snapshot[k];
            return v == null ? null : v;
          },
          set(k, v) {
            if (typeof k !== 'string' || !k) {
              throw new Error('env.set: key must be a non-empty string');
            }
            __state.env_writes[k] = v == null ? '' : String(v);
          },
          // getAll(): entire snapshot as a plain object
          // getAll(['a', 'b'])       — array of keys
          // getAll('a', 'b', 'c')    — variadic string args
          // getAll(['a', 'b'], 'c')  — mixed (tolerant of buggy generated
          //                            scripts that nest arrays). Missing
          //                            keys resolve to null.
          getAll(...args) {
            const src = __state.env_snapshot;
            if (args.length === 0) {
              const out = {};
              for (const k of Object.keys(src)) out[k] = src[k];
              return out;
            }
            const keys = [];
            const push = (v) => {
              if (Array.isArray(v)) {
                for (const inner of v) push(inner);
              } else if (v != null) {
                keys.push(String(v));
              }
            };
            for (const a of args) push(a);
            const out = {};
            for (const k of keys) {
              const v = src[k];
              out[k] = v == null ? null : v;
            }
            return out;
          },
        }),
        jwt: Object.freeze({
          // Accepts three call shapes so scripts ported from jsonwebtoken /
          // Postman / our own generator templates all work:
          //   sign(payload, key)                 — default HS256
          //   sign(payload, key, options)        — jsonwebtoken 3-arg form
          //   sign(payload, { key, alg, ... })   — single options object
          sign(payload, keyOrOptions, maybeOptions) {
            let options;
            if (maybeOptions !== undefined) {
              if (!maybeOptions || typeof maybeOptions !== 'object') {
                throw new Error('jwt.sign: third argument must be an options object');
              }
              options = { ...maybeOptions, key: keyOrOptions };
            } else if (keyOrOptions && typeof keyOrOptions === 'object') {
              options = keyOrOptions;
            } else if (typeof keyOrOptions === 'string') {
              options = { key: keyOrOptions };
            } else {
              throw new Error(
                'jwt.sign: expected (payload, key) or (payload, key, options) or (payload, options)'
              );
            }
            if (options.key == null || options.key === '') {
              const got =
                options.key === null
                  ? 'null'
                  : options.key === undefined
                    ? 'undefined'
                    : 'empty string';
              const envKeys = Object.keys(__state.env_snapshot);
              const hint = envKeys.length
                ? ' Available env keys: ' + envKeys.join(', ') + '.'
                : ' The active environment has no keys set.';
              throw new Error(
                'jwt.sign: key is required — got ' + got +
                '. If pulling from env, check that the env var holding your' +
                ' signing key is set for the active environment.' + hint
              );
            }
            return __jwtSign.applySync(
              undefined,
              [JSON.stringify(payload == null ? {} : payload), JSON.stringify(options)]
            );
          },
        }),
        // v4 UUID (random) — not cryptographically strong (the isolate has
        // no crypto API) but fine for jti / correlation IDs in scripts.
        uuid() {
          const hex = [];
          for (let i = 0; i < 256; i++) {
            hex[i] = (i < 16 ? '0' : '') + i.toString(16);
          }
          const r = [];
          for (let i = 0; i < 16; i++) r.push(Math.floor(Math.random() * 256));
          r[6] = (r[6] & 0x0f) | 0x40;
          r[8] = (r[8] & 0x3f) | 0x80;
          return (
            hex[r[0]] + hex[r[1]] + hex[r[2]] + hex[r[3]] + '-' +
            hex[r[4]] + hex[r[5]] + '-' +
            hex[r[6]] + hex[r[7]] + '-' +
            hex[r[8]] + hex[r[9]] + '-' +
            hex[r[10]] + hex[r[11]] + hex[r[12]] + hex[r[13]] + hex[r[14]] + hex[r[15]]
          );
        },
        log(...args) {
          __state.logs.push(args.map(__stringify).join(' '));
        },
        expect(cond, name) {
          const n = typeof name === 'string' && name ? name : 'expect';
          if (cond) {
            __state.test_results.push({ name: n, pass: true });
          } else {
            __state.test_results.push({
              name: n,
              pass: false,
              error: 'assertion failed',
            });
            throw new Error('expect: ' + n + ' failed');
          }
        },
        test(name, fn) {
          const n = String(name == null ? 'anonymous' : name);
          try {
            fn();
            __state.test_results.push({ name: n, pass: true });
          } catch (err) {
            __state.test_results.push({
              name: n,
              pass: false,
              error: String((err && err.message) || err),
            });
          }
        },
      });
      globalThis.khef = khef;

      // ---- Postman-like ergonomic top-level API ----
      // env as a proxy so scripts can do env.foo / env.foo = 'x'. Reads hit
      // the snapshot; writes both update the snapshot (so subsequent reads
      // see the new value within this run) and queue into env_writes for
      // persistence.
      const __envProxy = new Proxy(__state.env_snapshot, {
        set(target, key, value) {
          if (typeof key !== 'string' || !key) return false;
          const str = value == null ? '' : String(value);
          target[key] = str;
          __state.env_writes[key] = str;
          return true;
        },
        deleteProperty(target, key) {
          if (typeof key !== 'string') return false;
          delete target[key];
          __state.env_writes[key] = '';
          return true;
        },
      });
      globalThis.env = __envProxy;
      globalThis.setEnv = function (k, v) { __envProxy[k] = v; };
      globalThis.getEnv = function (k) {
        const v = __state.env_snapshot[k];
        return v == null ? null : v;
      };

      // console.* aliases onto khef.log so script output shows up in the
      // run's pre_script_log / test_script_log.
      globalThis.console = Object.freeze({
        log: function () {
          khef.log.apply(null, arguments);
        },
        info: function () {
          khef.log.apply(null, arguments);
        },
        warn: function () {
          const args = ['[warn]'].concat(Array.prototype.slice.call(arguments));
          khef.log.apply(null, args);
        },
        error: function () {
          const args = ['[error]'].concat(Array.prototype.slice.call(arguments));
          khef.log.apply(null, args);
        },
        debug: function () {
          khef.log.apply(null, arguments);
        },
      });

      // fetch via host bridge. Returns a Response-lite with .text()/.json()
      // returning promises (like the standard fetch API), and a flat
      // .headers object (not a Headers instance).
      globalThis.fetch = async function (url, options) {
        const resultJson = await __fetchHost.apply(
          undefined,
          [String(url), JSON.stringify(options == null ? {} : options)],
          { arguments: { copy: true }, result: { promise: true, copy: true } }
        );
        const parsed = JSON.parse(resultJson);
        return {
          ok: !!parsed.ok,
          status: parsed.status,
          statusText: '',
          headers: parsed.headers || {},
          text: async function () { return parsed.body || ''; },
          json: async function () {
            if (!parsed.body) throw new Error('Empty response body');
            return JSON.parse(parsed.body);
          },
        };
      };
    `;
    const bootScript = await isolate.compileScript(bootstrap);
    await bootScript.run(context);
    bootScript.release();

    // Wrap user code in an async IIFE so top-level `await` parses. A
    // runtime throw is captured in __state.runtime_error instead of
    // bubbling out of .run() (which would skip the readback).
    const wrapped = `
      (async function(){
        try {
          ${input.userCode}
        } catch (err) {
          __state.runtime_error = String((err && err.message) || err);
        }
      })();
    `;
    const userScript = await isolate.compileScript(wrapped, {
      filename: 'kapi-user-script.js',
    });
    try {
      // promise: true → isolated-vm awaits the IIFE's returned promise
      // inside the isolate before resolving on the host side.
      await userScript.run(context, {
        timeout: SCRIPT_TIMEOUT_MS,
        promise: true,
      });
    } finally {
      userScript.release();
    }

    const readback = `
      JSON.stringify({
        request: __state.request,
        env_writes: __state.env_writes,
        logs: __state.logs,
        test_results: __state.test_results,
        runtime_error: __state.runtime_error,
      });
    `;
    const readScript = await isolate.compileScript(readback);
    const resultJson = (await readScript.run(context, { timeout: 1_000 })) as string;
    readScript.release();

    const parsed = JSON.parse(resultJson) as {
      request: SandboxRequest;
      env_writes: Record<string, string>;
      logs: string[];
      test_results: TestResult[];
      runtime_error: string | null;
    };

    return {
      request: {
        method: String(parsed.request?.method ?? input.request.method),
        url: String(parsed.request?.url ?? input.request.url),
        headers: normalizeHeaders(parsed.request?.headers),
        body:
          parsed.request?.body === undefined
            ? input.request.body
            : parsed.request.body === null
              ? null
              : String(parsed.request.body),
      },
      env_writes: parsed.env_writes ?? {},
      log: (parsed.logs ?? []).join('\n'),
      test_results: parsed.test_results ?? [],
      error: parsed.runtime_error,
    };
  } catch (err) {
    return {
      request: input.request,
      env_writes: {},
      log: '',
      test_results: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    isolate.dispose();
  }
}

function normalizeHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== 'string' || !k) continue;
    if (v === null || v === undefined) continue;
    out[k] = String(v);
  }
  return out;
}

async function readCappedBody(
  stream: import('undici').Dispatcher.ResponseData['body'],
  cap: number
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    total += buf.length;
    if (total > cap) {
      chunks.push(buf.subarray(0, cap - (total - buf.length)));
      for await (const _ of stream) {
        /* drain */
      }
      break;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}
