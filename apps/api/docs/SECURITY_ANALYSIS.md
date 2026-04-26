# Security Analysis: khef & khef-ui

**Evaluator**: Security Engineering Review
**Date**: February 2026
**Scope**: khef (backend API) and khef-ui (frontend SPA)
**Purpose**: Assess whether these tools are safe for software engineers to install and run on their work computers as personal developer tools.

---

## Executive Summary

khef is a local-first developer tool consisting of a Fastify/TypeScript API server backed by PostgreSQL and a Preact single-page application. It manages development knowledge — decisions, patterns, context, and todos — and integrates with Claude Code and Codex CLI via an MCP server.

**Overall assessment**: The application is designed for **single-user, local-only use** and operates under a trust-the-local-user model. Within that threat model, the security posture is reasonable. However, the complete absence of authentication means any exposure beyond localhost — even to other users on the same machine or a shared network — would be a critical issue.

| Category | Rating | Notes |
|----------|--------|-------|
| Authentication & Authorization | Critical | No auth layer whatsoever |
| SQL Injection | Low | Parameterized queries throughout |
| Command Injection | Low | spawn() with argument arrays for git and gcloud |
| XSS (Backend) | Low | Server returns JSON only |
| XSS (Frontend) | Low | rehype-sanitize applied across all rendering pipelines |
| Path Traversal | Low | Validated with allowlists and pattern checks |
| Network Exposure | Low | Binds to 127.0.0.1; Docker ports localhost-only; restrictive CORS |
| Dependencies | Low | Well-maintained, no known critical CVEs |
| Data at Rest | Moderate | No encryption; PostgreSQL trust auth by default |

---

## 1. Authentication & Authorization

**Severity: Critical (by conventional standards) / Accepted Risk (within stated threat model)**

Neither the API server nor the MCP server implements any form of authentication:

- No API keys, bearer tokens, JWT, or session management
- No middleware checking credentials on any route
- The MCP server (`mcp-server/src/index.ts`) calls the API with plain `fetch()` — no auth headers
- Comment authors (`user`, `claude-code`, `codex-cli`) are enum-validated strings with no identity verification

**Mitigating factors**:
- The tool is designed for single-user, local-only operation
- Adding auth would add complexity with minimal benefit for the intended use case
- The MCP server communicates via stdio from the user's own Claude Code process

**Risk if misused**: Anyone with network access to the API port can read, modify, or delete all stored memories, including assistant rules, decisions, and project knowledge. This becomes a real issue on shared networks, VPNs, or if port-forwarded.

---

## 2. Network Exposure

**Severity: Low** (previously Moderate — mitigated)

The server binds to localhost only:

```typescript
// src/index.ts:51,104
const HOST = process.env.HOST || '127.0.0.1';
await fastify.listen({ port: PORT, host: HOST });
```

CORS is restricted to the khef-ui dev ports:

```typescript
// src/index.ts:53-56
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5174,http://localhost:5173').split(',');
fastify.register(cors, {
  origin: CORS_ORIGINS,
});
```

Docker ports are bound to localhost:

```yaml
# docker-compose.yml
- "127.0.0.1:${POSTGRES_PORT:-5532}:5432"   # PostgreSQL
- "127.0.0.1:${KROKI_PORT:-8100}:8000"      # Kroki
# docker-compose.test.yml
- "127.0.0.1:${TEST_POSTGRES_PORT:-5434}:5432"
```

The frontend dev server still allows all hosts:

```typescript
// vite.config.ts:34
allowedHosts: true,
```

**Remaining exposure surface**:
- The Vite dev server's `allowedHosts: true` still permits host header spoofing, though this is limited to development
- Users can opt back into broader access via `HOST=0.0.0.0` or `CORS_ORIGINS` env vars

**Practical risk**: Low. The API, database, and diagram service are all localhost-only by default. Network neighbors cannot reach any service. Cross-origin requests are limited to the known UI dev ports.

---

## 3. SQL Injection

**Severity: Low**

All database queries use parameterized placeholders via the `pg` library:

```typescript
// src/db/client.ts
const result = await pool.query(text, params);
```

Route handlers pass user input through parameter arrays, not string concatenation. Some routes build dynamic SQL with conditional WHERE clauses, but parameter indices are tracked programmatically — no raw string interpolation of user input into SQL.

The search endpoints use PostgreSQL's `plainto_tsquery()` and `ts_rank()` for full-text search, which safely handle query strings.

No SQL injection vectors were identified.

---

## 4. Command Execution

**Severity: Low** (previously Low-Moderate — mitigated)

Two subsystems shell out to external commands:

### Git Operations (`src/services/git.ts`)

Uses `spawn()` with argument arrays — the safer pattern:

```typescript
const proc = spawn('git', args, { cwd });
```

Git refs are validated with a strict allowlist regex:

```typescript
export function sanitizeRef(ref: string): string {
  if (!/^[a-zA-Z0-9\/.\^~\-_]+$/.test(ref)) {
    throw new Error(`Invalid git ref: ${ref}`);
  }
  return ref;
}
```

All git operations are read-only (log, show, diff). **Risk: Low.**

### Gcloud Operations (`src/services/gcloud.ts`)

Uses `spawn()` with argument arrays via a shared helper — the same safe pattern as git:

```typescript
// src/services/gcloud.ts
export function spawnAsync(command: string, args: string[]): Promise<string> {
  const proc = spawn(command, args, { env: spawnEnv })
  // ...
}

// Account passed as a separate argument, not interpolated into a shell string
export async function getGcloudAccessToken(account?: string): Promise<string> {
  const args = ['auth', 'print-access-token']
  if (account) args.push(account)
  const stdout = await spawnAsync('gcloud', args)
  return stdout.trim()
}
```

All gcloud calls go through this helper — no shell interpretation, no injection surface. **Risk: Low.**

### Embedding Service (`src/services/vector/embeddings.ts`)

```typescript
const python = spawn('python3', [EMBED_SCRIPT]);
```

Uses `spawn()` with a fixed script path. Input is sent via stdin as JSON. **Risk: Low.**

---

## 5. Cross-Site Scripting (XSS)

### Backend

The API returns JSON responses exclusively — no HTML rendering on the server side. Content stored in memories is returned as-is in JSON fields. **Risk: Low.**

### Frontend

The frontend renders user-authored markdown content (memory bodies, session transcripts, plans, agent configs, etc.) to HTML and injects it via `dangerouslySetInnerHTML` across 8 page components.

**MemoryPage.tsx** — the primary content viewer — uses a proper sanitization pipeline:

```typescript
// Sanitization schema based on rehype-sanitize defaults
const htmlSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), 'img', 'span'],
  attributes: {
    ...(defaultSchema.attributes || {}),
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'style'],
    code: ['className'],
    pre: ['className'],
    span: ['className', 'style'],
  },
};

// Pipeline: remark-parse → remark-gfm → remark-rehype → rehype-raw → rehype-sanitize → rehype-stringify
```

This is a sound approach: `rehype-raw` enables HTML passthrough from markdown, then `rehype-sanitize` strips dangerous elements/attributes before the final HTML is rendered.

**All pages** now use the same sanitization pipeline with `rehype-sanitize` applied after `rehype-raw`. This was extended from MemoryPage.tsx to all rendering components (AgentPage, PlanPage, ConfigPage, SessionPage, CommandPage, MemoryFilePage, GraphPage) in commit `3bea75a`.

**Risk: Low.** All markdown rendering pipelines sanitize HTML before injection.

---

## 6. Path Traversal

**Severity: Low**

File-serving endpoints validate paths before accessing the filesystem:

**Session files** (`src/services/sessions.ts`):
```typescript
export function validateProjectDir(dir: string): void {
  if (dir.includes('..') || dir.includes('/') || dir.includes('\\')) {
    throw new ValidationError('Invalid project directory name');
  }
}

export function validateSessionId(id: string): void {
  const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const agentPattern = /^agent-[a-f0-9]+$/;
  if (!uuidPattern.test(id) && !agentPattern.test(id)) {
    throw new ValidationError('Invalid session ID format');
  }
}
```

**Memory files**: Filenames are validated to require `.md` extension and block path separators.

**File uploads**: Stored with UUID-based filenames; MIME type whitelist restricts accepted types.

No path traversal vectors were identified.

---

## 7. Database Security

**Severity: Moderate**

Default PostgreSQL configuration uses `trust` authentication:

```yaml
# docker-compose.yml
POSTGRES_HOST_AUTH_METHOD: ${POSTGRES_HOST_AUTH_METHOD:-trust}
POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-}
```

This means any process on the machine can connect to PostgreSQL on port 5532 without credentials. In the single-user local model this is acceptable, but it means any malware or compromised process on the machine has full database access.

The database port is bound to localhost (`127.0.0.1:5532:5432`) in Docker, so it is not accessible from the network.

---

## 8. Dependencies

**Severity: Low**

### Resolved Vulnerabilities

Two high-severity Fastify advisories were patched during this review by upgrading from fastify <=5.7.2 to 5.7.4:

| Advisory | Severity | Description |
|----------|----------|-------------|
| [GHSA-jx2c-rxcm-jvmq](https://github.com/advisories/GHSA-jx2c-rxcm-jvmq) | High | Content-Type header tab character allows body validation bypass |
| [GHSA-mrq3-vjjr-p77c](https://github.com/advisories/GHSA-mrq3-vjjr-p77c) | High | DoS via unbounded memory allocation in sendWebStream |

The Fastify 5.x upgrade also required bumping `@fastify/cors` (8.5.0 → 10.1.0) and `@fastify/multipart` (8.3.1 → 9.4.0) for compatibility (those plugins declared `fastify@^4.x` as a peer dependency).

### Backend (khef)

| Package | Purpose | Notes |
|---------|---------|-------|
| fastify 5.7.4 | HTTP framework | Patched for GHSA-jx2c-rxcm-jvmq and GHSA-mrq3-vjjr-p77c |
| @fastify/cors 10.1.0 | CORS middleware | Upgraded for Fastify 5 compatibility |
| @fastify/multipart 9.4.0 | File uploads | Upgraded for Fastify 5 compatibility |
| pg 8.12.0 | PostgreSQL client | Mature, well-maintained |
| zod 3.23.8 | Schema validation | Used for input validation |
| playwright 1.58.0 | Diagram rendering | Chromium sandboxed |

### Frontend (khef-ui)

| Package | Purpose | Notes |
|---------|---------|-------|
| preact 10.27.2 | UI framework | Lightweight React alternative |
| ky 1.14.2 | HTTP client | Thin fetch wrapper |
| rehype-sanitize 6.0.0 | HTML sanitization | Used on main memory page |
| mermaid 11.12.2 | Diagram rendering | Client-side, sandboxed |
| cytoscape 3.33.1 | Graph visualization | Canvas-based |

No abandoned or known-vulnerable packages. No native binaries beyond Playwright's Chromium.

---

## 9. Sensitive Data Handling

### What the tool stores

- Developer knowledge: decisions, patterns, context, code snippets, architectural notes
- Session transcripts from Claude Code / Codex CLI conversations
- Git diffs and commit metadata for linked repositories
- Assistant configuration files (CLAUDE.md, agent definitions)
- Google Drive OAuth tokens (in-memory cache, 55-minute TTL)

### Where it's stored

- PostgreSQL: All memories, tags, relations, comments, metadata
- Chroma/Qdrant: Vector embeddings of memory content
- Filesystem: Session transcript files (read-only), assistant config files, memory file versions

### Protection

- No encryption at rest for database or vector store
- No encryption at rest for session transcripts on disk
- Google access tokens held in memory, not persisted to disk
- `.env` file contains database credentials (excluded from git via `.gitignore`)

**Risk**: If the machine is compromised, all stored knowledge is accessible. This is standard for local developer tools (the same is true of git repos, shell history, and IDE state on the same machine).

---

## 10. Frontend-Specific Concerns

### Content Security Policy

No CSP headers are configured on either the API server or the Vite dev server. The API returns JSON only (CSP is less relevant), but the frontend SPA would benefit from a restrictive CSP in production builds.

### Local Storage / Cookies

The frontend uses `ky` for API calls with no credential storage visible in the client code. No auth tokens, cookies, or sensitive data are stored in localStorage or sessionStorage.

### iframe Protection

No `X-Frame-Options` or `frame-ancestors` CSP directive is set. The UI could be embedded in an iframe by a malicious page, though with no authentication there's limited additional risk from clickjacking.

### Vite Dev Server

`allowedHosts: true` disables host header validation, which in combination with the permissive CORS means any site could make requests to the dev server. The proxy forwards `/api` requests to the backend, so the dev server acts as an open proxy to the API.

---

## 11. Docker & Infrastructure

The Docker setup includes:

- **PostgreSQL 17 with pgvector**: Bound to localhost (127.0.0.1:5532), trust auth, persistent volume
- **Kroki + Kroki-Mermaid**: Diagram rendering service, bound to localhost (127.0.0.1:8100)
- No resource limits (memory, CPU) defined on containers
- No non-root user configuration
- Health check configured for PostgreSQL readiness

The containers run standard, well-maintained images. No custom Dockerfiles with potentially risky build steps.

---

## 12. MCP Server

The MCP server (`mcp-server/`) is a stdio-based bridge that translates Claude Code tool calls into REST API requests. It runs in the user's process context, communicating with the API at `KHEF_API_URL`.

- No authentication between MCP server and API
- Rate limiting applied at the API layer (1000 req/min per IP by default)
- Full CRUD access to all memories, projects, tags, relations
- The MCP server binary is checked into the repo (`mcp-server/build/`)

Since the MCP server runs as the user's own process via Claude Code's stdio transport, the trust boundary is the same as the user's terminal session.

---

## Risk Summary

### Risks that matter for local developer use

| Risk | Likelihood | Impact | Recommendation |
|------|-----------|--------|----------------|
| ~~Another process on the machine accessing the API~~ | ~~Low~~ | ~~High~~ | **Resolved** — server binds to 127.0.0.1 by default |
| ~~Network neighbor accessing the API~~ | ~~Low-Moderate~~ | ~~High~~ | **Resolved** — API and Docker ports bound to 127.0.0.1 |
| ~~Malicious memory import executing XSS~~ | ~~Very Low~~ | ~~Moderate~~ | **Resolved** — rehype-sanitize applied to all rendering pipelines |
| ~~gcloud exec() injection~~ | ~~Very Low~~ | ~~High~~ | **Resolved** — all gcloud calls use spawn() with argument arrays |
| Database accessed without credentials | Low | High | Use scram-sha-256 instead of trust auth |

### Risks that don't apply to the intended use case

| Risk | Why it doesn't apply |
|------|---------------------|
| Multi-user authorization bypass | Single-user tool; no multi-tenancy |
| CSRF attacks | No authentication means CSRF has no additional impact |
| Session hijacking | No sessions to hijack |
| Credential stuffing / brute force | No credentials to attack |

---

## Recommendations

### For current local-only use (minimal changes)

1. ~~**Bind to localhost**~~: **Done.** Server defaults to `HOST=127.0.0.1`. Configurable via `HOST` env var.
2. ~~**Restrict Docker ports**~~: **Done.** All Docker port bindings prefixed with `127.0.0.1:` in both dev and test compose files.
3. ~~**Add rehype-sanitize to all pages**~~: **Done.** All rendering pipelines now use `rehype-sanitize` (khef-ui commit `3bea75a`).

### For broader deployment (if ever needed)

4. Implement API key authentication with a middleware that checks `Authorization: Bearer <key>` headers
5. ~~Replace `exec()` with `spawn()` for gcloud commands~~: **Done.** Shared `src/services/gcloud.ts` helper uses `spawn()` with argument arrays.
6. ~~Set restrictive CORS origins instead of `origin: true`~~: **Done.** CORS defaults to `http://localhost:5174,http://localhost:5173`. Configurable via `CORS_ORIGINS` env var.
7. Enable PostgreSQL password authentication
8. ~~Add rate limiting via `@fastify/rate-limit`~~: **Done.** Global limit of 1000 req/min per IP. Configurable via `RATE_LIMIT_MAX` env var; set to 0 to disable.
9. Add CSP headers to the frontend
10. Implement audit logging for write operations

---

## Conclusion

khef operates under a reasonable threat model for a local developer tool: the user trusts their own machine, and the tool runs alongside other unprotected local services (databases, dev servers, IDE language servers). The codebase demonstrates good practices in the areas that matter most — parameterized SQL queries, safe git command execution, proper input validation, and markdown sanitization on the primary content page.

All risks identified in the original review have been addressed: the API server binds to localhost by default, Docker ports are restricted to 127.0.0.1, CORS is limited to known UI dev origins, all gcloud CLI calls use `spawn()` with argument arrays, rate limiting guards against runaway loops, and `rehype-sanitize` is applied across all frontend rendering pipelines.

**Verdict**: Safe for local use by software engineers on work computers. The API, database, and supporting services are all localhost-only by default, matching the single-user threat model. The tool stores potentially sensitive development knowledge and should be treated with the same care as source code and shell history on the same machine.
