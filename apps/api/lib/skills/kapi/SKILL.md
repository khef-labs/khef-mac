---
name: kapi
description: This skill should be used when the user asks to "test an API endpoint", "create an API definition", "add a kapi request", "build a request for {service} API", "scaffold a JWT signer", "save this curl", "run a request against {host}", or wants to check an HTTP call without leaving khef. Also triggers on bare "kapi", "create a kapi def", "create a kapi collection", or requests to turn a curl/OpenAPI spec into saved requests.
---

# Kapi — Built-in API Tool

Kapi is khef's in-repo replacement for Postman/Insomnia/curl. It stores **Collections** (the top-level grouping), **Definitions**, **Requests**, **Environments** with secret-aware **EnvVars**, and a **Run history** in the `kapi.*` Postgres schema. Kapi collections are independent of khef projects — pick or create one before adding definitions.

Requests execute server-side through `undici` with manual redirect handling (3xx surfaces to the caller — sidesteps the known undici auth-leakage CVE class).

## Resource model

```
collection ──▶ definition (base_url, default_auth)
                 └── request (method, path, headers, query, body,
                              pre_script_content, test_script_content)
collection ──▶ environment (one active at a time)
                 └── env_var (plaintext or is_secret=true, AES-256-GCM encrypted)
collection ──▶ runs (append-only, redacted auth headers)
```

Pre- and test-scripts are plain text columns on the request row — no separate scripts table, no attach/detach step. Deleting a request takes its scripts with it. To reuse a script across requests, use `copy_kapi_script` or regenerate via the `generate_kapi_*_script` tools.

URLs use `{{varName}}` placeholders resolved from the active environment on Send. Unresolved placeholders are left literal so the user notices a missing var.

## Canonical workflow

For a new API you want to test:

1. **Pick or create a collection.** `list_kapi_collections` to check what exists; `create_kapi_collection` if you need a new one. Collections take `handle`, `name`, optional `description` — no project FK.
   ```
   create_kapi_collection(handle: "stripe", name: "Stripe API")
   ```
2. **Create the definition** with a placeholder base URL — promote the host to an env var from the start so swapping environments doesn't require re-editing the definition.
   ```
   create_kapi_definition(
     collection_id: "<handle-or-uuid>",
     handle: "<kebab-case>",
     name: "<human name>",
     base_url: "{{host}}"
   )
   ```
3. **Add requests** for each endpoint, using `{{var}}` placeholders for any path segment that varies across environments (host, account ID, project ID, etc.)
   ```
   add_kapi_request(
     definition_id: "<uuid>",
     name: "Get user",
     method: "GET",
     path: "/v2/users/{{userId}}",
     headers: [{key: "Accept", value: "application/json", enabled: true}]
   )
   ```
4. **Create an environment + vars**. Always include `host` plus any IDs the requests reference. For multi-env setups (sandbox/staging/prod) clone the env and just swap the values — request paths never need to change.
   ```
   create_kapi_environment(collection_id, handle: "sandbox", name: "Sandbox", is_active: true)
   set_kapi_env_var(environment_id, key: "host", value: "https://api.sandbox.example.com")
   set_kapi_env_var(environment_id, key: "userId", value: "abc-123")
   set_kapi_env_var(environment_id, key: "apiToken", value: "...", is_secret: true)
   ```
5. **Run** — either a saved request or ad-hoc
   ```
   run_kapi_request(request_id: "<uuid>")
   run_kapi_ad_hoc(collection_id, method: "GET", url: "...", headers: [...])
   ```

Every run is saved to `kapi.runs` with redacted auth headers. Use `list_kapi_runs` / `get_kapi_run` for history.

## When the user pastes curl

Parse the curl into fields and call `add_kapi_request` once. Don't ask multiple clarifying questions — extract what you can:

| curl flag | kapi field |
|-----------|-----------|
| `-X METHOD` / `--request` | `method` |
| bare URL | split into `base_url` (definition) + `path` (request) |
| `-H "Key: Value"` / `--header` | `headers` entry |
| `?k=v&k2=v2` | `query_params` entries |
| `-d` / `--data` / `--data-raw` | `body_content` (set `body_type: "raw"`, `body_language: "json"` if it parses) |
| `-u user:pass` | suggest creating `auth_override` with `kind: "basic"` referencing env vars |
| `Authorization: Bearer xxx` | move the token into an env var, point `default_auth` at it |

## When the user pastes OpenAPI

Use `import_openapi` once the tool exists (not yet wired — for now, read the spec, create a definition, and loop `add_kapi_request` per operation).

## Auth patterns

| Auth style | How to set up |
|-----------|---------------|
| Bearer token | env var `authToken`, `default_auth: {kind: "bearer", tokenVar: "authToken"}` |
| Basic | env var for password, `default_auth: {kind: "basic", username: "...", passwordVar: "..."}` |
| Custom header (API key) | env var, `default_auth: {kind: "api-key", headerName: "X-Api-Key", tokenVar: "..."}` |
| JWT (signed per request) | `generate_kapi_jwt_script` writes a pre-request script onto the target request; runs before the HTTP call via the isolated-vm sandbox |
| OAuth 2.0 client_credentials | `generate_kapi_client_credentials_script` writes a pre-request script that caches the token in env, refreshes on expiry, and sets `Authorization: Bearer` automatically |

To apply the same script to several requests, generate it once on one request then call `copy_kapi_script` from that request to each target. Scripts are plain text copies — no shared row, no cleanup to worry about.

**Secrets**: always pass `is_secret: true` to `set_kapi_env_var` for private keys, client secrets, refresh tokens. They encrypt with `KAPI_SECRET_KEY` at rest and redact to `***redacted***` in every read path (MCP responses, run history, UI).

## Useful tools in this skill

| Purpose | Tool |
|---------|------|
| List / create collections | `list_kapi_collections`, `create_kapi_collection`, `update_kapi_collection`, `delete_kapi_collection` |
| List definitions in a collection | `list_kapi_definitions` |
| Create / modify definitions | `create_kapi_definition`, `update_kapi_definition`, `delete_kapi_definition` |
| Create / modify requests | `add_kapi_request`, `update_kapi_request`, `delete_kapi_request`, `list_kapi_requests` |
| Execute | `run_kapi_request`, `run_kapi_ad_hoc` |
| History | `list_kapi_runs`, `get_kapi_run` |
| Environments | `list_kapi_environments`, `create_kapi_environment`, `activate_kapi_environment` |
| Env vars | `set_kapi_env_var`, `list_kapi_env_vars` |
| Scripts | `copy_kapi_script`, `generate_kapi_jwt_script`, `generate_kapi_client_credentials_script` (scripts live on the request row itself — use `update_kapi_request` with `pre_script_content` / `test_script_content` to set arbitrary content) |

## Important caveats

- **Collection identifiers accept both UUIDs and handles.** Tools like `list_kapi_definitions` resolve `collection_id: "stripe"` to the matching collection.
- **Path parameters**: use `{{varName}}` placeholders (Postman-compatible). Not `:param`.
- **Path storage**: if a request's `path` is already absolute (`https://…`), the runner uses it verbatim and skips the base_url join. Normal case: store relative paths and let `base_url` prepend.
- **Redirects are not followed**. 3xx responses surface with `Location` intact — users testing OAuth / SAML flows want to see every hop.
- **KAPI_SECRET_KEY** must be set on the API process to store or read secret env vars. `openssl rand -base64 32` generates one.
- **Scripts** (pre-request / test) run inside an isolated-vm V8 isolate (128 MB cap, 5 s wall-clock) with an async top-level — `await` is allowed at the script root. Each request's script lives as plain text on the request row (`pre_script_content` / `test_script_content`); there is no separate `scripts` table and no attach/detach step. Deleting a request drops its scripts automatically. To share a script across requests, generate/write it once then `copy_kapi_script` to the others.

  **Core `khef.*` surface:**
  - `khef.request.{method,url,body}` + `khef.request.headers[key]=value` mutate the outgoing request
  - `khef.response.{status,headers,body}` is read-only inside test scripts
  - `khef.env.get(k)` / `khef.env.set(k, v)` reads the resolved snapshot and queues writes back to the active environment (plaintext only — no way to write secrets from a script)
  - `khef.jwt.sign(payload, {alg, key, ...})` wraps `jsonwebtoken` on the host side so scripts can mint tokens without touching the key material
  - `khef.log(...)`, `khef.expect(cond, name)`, `khef.test(name, fn)` capture into the run record's `pre_script_log` / `test_script_log` / `test_results`

  **Postman-like top-level ergonomics (all usable without the `khef.` prefix):**
  - `env.foo` reads, `env.foo = "x"` writes (same storage as `khef.env.get/set`)
  - `getEnv(k)` / `setEnv(k, v)` — function aliases
  - `console.log / info / warn / error / debug` — all alias to `khef.log` with a small `[warn]` / `[error]` prefix where applicable
  - `fetch(url, { method, headers, body })` — host-bridged undici call returning a Response-lite `{ ok, status, headers, text(), json() }`. Useful for OAuth client_credentials prefetches before the main request. No redirect following; 15 s timeout; counts against the 5 s script wall-clock.
- **UI**: the same resources are editable at `/kapi` (or `/kapi/<collection-handle>` for direct linking) — mention the link after creating things so the user can keep iterating visually. The collection dropdown sits at the top of the sidebar; its gear button opens the Collections modal for create/rename/delete. The Env dropdown beneath it has its own gear button for the Environments & variables modal.

## Anti-patterns

- Don't create a new collection per request — group by API or organization (e.g. one collection per service or vendor).
- Don't create a new definition per request — group by host/API inside the collection.
- Don't put secrets in `headers` verbatim — reference an env var via `{{var}}`.
- Don't call `query_kapi` (raw SQL) when a dedicated tool exists — it doesn't redact secrets on all columns as aggressively as the REST path.
- Don't use the UI's "insecure TLS" toggle against anything outside localhost/sandbox hosts.
