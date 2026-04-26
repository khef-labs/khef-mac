# RDR-005: Vector DB Integration for Semantic Search

**Status:** Implemented (kvec)
**Date:** 2026-01-28
**Updated:** 2026-02-09
**Authors:** Roger, Claude

## Context

Current search uses PostgreSQL `websearch_to_tsquery` with weighted ranking across title, content, chunks, and tags. This works well for keyword matching but misses conceptually related content that uses different terminology.

For example, searching "authentication" won't find memories about "login", "OAuth", or "sessions" unless those exact words appear. Semantic search uses embeddings to find content by meaning rather than exact words.

## Decision

Use **kvec** (an in-repo pgvector-backed library) for all vector storage and search. Replaced the original Chroma/Qdrant provider abstraction in Phase 2. Embeddings live in PostgreSQL alongside the rest of khef's data — no external vector DB required.

### 1. Architecture: kvec (pgvector in PostgreSQL)

All embeddings are stored in the `kvec` schema inside the same PostgreSQL database used by the rest of khef. No external vector services required.

| Component | Description |
|-----------|-------------|
| **kvec library** | `packages/kvec/` — TypeScript library for collections, chunking, embedding, search |
| **Embedding server** | Python sidecar on port 9100 (`embed_server.py`) — `sentence-transformers` + tree-sitter AST chunking |
| **Storage** | `kvec.collections`, `kvec.tracked_files`, `kvec.chunks` tables with pgvector |

#### kvec Schema

```sql
kvec.collections       -- Collection metadata (name, model, dimensions, store_type)
kvec.repos             -- Git repo info (name, root_path, remote_url)
kvec.snapshots         -- Branch + commit per repo
kvec.tracked_files     -- Files with content_hash for dedup
kvec.chunks            -- Embedded chunks with pgvector embedding column
kvec.upload_events     -- Upload audit trail
```

#### Collections

| Collection | Purpose | Model | Dimensions |
|------------|---------|-------|------------|
| `khef-memories` | Memory embeddings for semantic search | all-mpnet-base-v2 | 768 |
| `khef-sessions` | Session transcript embeddings | all-mpnet-base-v2 | 768 |
| `kvec-source` | Source code embeddings (via `kvec:embed` CLI) | all-mpnet-base-v2 | 768 |

### 2. Sync Strategy: Async Eventual Consistency

Background worker runs every 30s. PG writes are fast; vector sync happens asynchronously.

**Write path**: On memory create/update, set `vector_synced_at = NULL`. On delete, queue in `vector_delete_queue`. No embedding in the hot path.

**Sync worker**: Finds dirty memories (`vector_synced_at IS NULL OR < updated_at`), calls `collection.ingestContent()` to chunk + embed + store, then marks synced.

**Benefits**: Zero write latency, resilient to sidecar downtime (queue grows, catches up later), batch-friendly.

### 3. Chunking

#### Memory/Session Chunking
Token-aware chunking with model-specific limits. Content split at token boundaries.

#### Source Code Chunking (AST-aware)
Tree-sitter AST parsing via LlamaIndex `CodeSplitter` supporting 35+ languages. Falls back to line-based chunking if tree-sitter parsing fails.

```
kvec-embed.ts → KVec → ASTSidecarChunker → POST /chunk (embed_server.py)
                                              ↓
                                   LlamaIndex CodeSplitter + tree-sitter
                                              ↓
                                   Falls back to line-based chunking
```

Supported languages: Python, TypeScript, JavaScript, Java, Go, Rust, C, C++, C#, Ruby, PHP, Kotlin, Scala, Swift, Bash, SQL, HTML, CSS, YAML, JSON, TOML, Lua, Elixir, Haskell, OCaml, Perl, and more.

### 4. API

#### Memory Search (`mode=semantic`)

```
GET /api/memories?q=<query>&mode=semantic&project_id=<optional>&type=<optional>&limit=20
```

Uses kvec `collection.query()` with pgvector cosine similarity. Deduplicates by `memory_id`, returns best chunk score per memory.

#### Session Search

```
GET /api/assistants/{handle}/sessions/search?q=<query>&mode=semantic
```

#### MCP Tools

- `search_memories(q, mode='semantic')` — semantic memory search via kvec
- `search_sessions(q, mode='semantic')` — semantic session search via kvec

### 5. Source Code Embedding CLI

```bash
npm run kvec:embed                                # embed current directory
npm run kvec:embed -- /path/to/dir                # embed specific directory
npm run kvec:embed -- /path/to/file.ts            # embed single file
npm run kvec:embed -- -c my-collection            # custom collection name
npm run kvec:embed -- -e .ts,.js,.py              # filter extensions
npm run kvec:embed -- --limit 10                  # limit files
```

Features:
- Git-aware paths (stores relative to git root)
- Content-hash dedup (skips unchanged files)
- AST-aware chunking for source code
- Size-sorted processing (small files first)
- Single-line progress output

### 6. Implementation Files

| File | Purpose |
|------|---------|
| `packages/kvec/src/` | kvec library (collection, storage, chunking, embedding) |
| `packages/kvec/src/chunking/ast-sidecar.ts` | AST chunker calling Python sidecar |
| `packages/kvec/src/chunking/token-aware.ts` | Token-aware text chunker |
| `packages/kvec/src/chunking/markdown.ts` | Heading-aware markdown chunker |
| `packages/kvec/src/ingest.ts` | Directory ingestion with git detection |
| `apps/api/scripts/kvec-embed.ts` | CLI for source code embedding |
| `apps/api/src/services/vector/embed_server.py` | Python sidecar: `/embed` + `/chunk` endpoints |
| `apps/api/src/services/vector/embed.py` | Standalone embedding script (fallback) |
| `apps/api/src/services/kvec-service.ts` | Singleton kvec instance for API |
| `apps/api/src/services/vector-sync.ts` | Background memory sync worker |
| `apps/api/src/services/session-embeddings.ts` | Session embedding sync |
| `apps/api/src/routes/vector-search.ts` | Semantic search route |

### 7. Dependencies

**Python** (`apps/api/requirements.txt`):
- `sentence-transformers>=2.2.0` — embedding model (all-mpnet-base-v2)
- `llama-index-core>=0.12.0` — CodeSplitter for AST chunking
- `tree-sitter-language-pack>=0.6.0` — grammar support for 165+ languages

**Node** (`packages/kvec/package.json`):
- `pgvector` — pgvector client for PostgreSQL

## Security Considerations

### Data Locality

All data stays local:
- Embeddings stored in PostgreSQL (same database as all khef data)
- `all-mpnet-base-v2` embeddings computed locally via Python sidecar
- No external API calls

### Content in kvec

kvec stores document text alongside embeddings in `kvec.chunks`. This is a copy of content already in PG memory tables. No additional attack surface beyond existing database access.

## Consequences

### Positive

1. **Conceptual search** - Find related content without exact keywords
2. **Fully local** - No external APIs or services, works offline
3. **Single database** - Everything in PostgreSQL, no Chroma/Qdrant container needed
4. **Zero write impact** - Async sync means no latency added to writes
5. **AST-aware chunking** - Source code split at function/class boundaries for better retrieval
6. **Content-hash dedup** - Files only re-embedded when content changes

### Superseded

The original Chroma/Qdrant provider abstraction (implemented Jan 2026) was replaced by kvec (Feb 2026). The old `VectorProvider` interface, `chroma.ts`, `qdrant.ts`, and `memory_embeddings` table are removed.

## References

- [pgvector](https://github.com/pgvector/pgvector) — vector similarity for PostgreSQL
- [all-mpnet-base-v2 on HuggingFace](https://huggingface.co/sentence-transformers/all-mpnet-base-v2)
- [LlamaIndex CodeSplitter](https://docs.llamaindex.ai/) — AST-aware code chunking
- [tree-sitter](https://tree-sitter.github.io/) — parsing library for source code

---

## Implementation History

### Phase 1: Chroma/Qdrant Provider Abstraction (2026-01-28)

Original implementation used a `VectorProvider` interface with Chroma and Qdrant adapters. Embeddings were stored in a `memory_embeddings` table, then synced to external providers. This worked but required running an external Docker container.

### Phase 2: kvec Replacement (2026-02-09)

Replaced the entire provider abstraction with kvec — a pgvector-backed library in `packages/kvec/`. All embeddings now live in PostgreSQL. Removed `chroma.ts`, `qdrant.ts`, `vector-compare.ts`, `memory_embeddings` table, and the provider factory.

### Phase 3: AST-Aware Source Code Embedding (2026-02-09)

Added `kvec:embed` CLI tool and tree-sitter based AST chunking for source code. The Python sidecar gained a `/chunk` endpoint using LlamaIndex `CodeSplitter` with `tree-sitter-language-pack` supporting 35+ languages. Non-code files fall back to token-aware or line-based chunking.
