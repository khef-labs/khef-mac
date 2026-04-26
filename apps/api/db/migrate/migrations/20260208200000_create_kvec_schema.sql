-- Migration: Create kvec schema for embedded vector database
-- Creates dedicated kvec schema with collections, repos, snapshots,
-- tracked_files, chunks, and upload_events tables.
-- pgvector extension already enabled from migration 20260128171042.

-- UP

CREATE SCHEMA IF NOT EXISTS kvec;

-- Collection registry: top-level container users manage
CREATE TABLE kvec.collections (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL UNIQUE,
    description     text,
    embedding_model text NOT NULL,
    dimensions      int NOT NULL,
    store_type      text NOT NULL DEFAULT 'mixed',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Git repositories (normalized from tracked_files)
CREATE TABLE kvec.repos (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id   uuid NOT NULL REFERENCES kvec.collections(id) ON DELETE CASCADE,
    name            text NOT NULL,
    root_path       text NOT NULL,
    remote_url      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    UNIQUE(collection_id, name)
);

-- Point-in-time repo state (normalized git columns)
CREATE TABLE kvec.snapshots (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id         uuid NOT NULL REFERENCES kvec.repos(id) ON DELETE CASCADE,
    branch          text NOT NULL,
    commit_hash     text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    UNIQUE(repo_id, branch, commit_hash)
);

-- Per-file tracking: the core unit of change detection
CREATE TABLE kvec.tracked_files (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id   uuid NOT NULL REFERENCES kvec.collections(id) ON DELETE CASCADE,
    repo_id         uuid REFERENCES kvec.repos(id) ON DELETE CASCADE,
    snapshot_id     uuid REFERENCES kvec.snapshots(id),
    file_path       text NOT NULL,
    content_hash    text NOT NULL,
    file_size       bigint NOT NULL,
    language        text,
    status          text NOT NULL DEFAULT 'active',
    error_message   text,
    metadata        jsonb,
    uploaded_at     timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    UNIQUE NULLS NOT DISTINCT (collection_id, repo_id, file_path, snapshot_id)
);

-- Vector chunks: the actual embeddings
CREATE TABLE kvec.chunks (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id         uuid NOT NULL REFERENCES kvec.tracked_files(id) ON DELETE CASCADE,
    chunk_index     int NOT NULL,
    content         text NOT NULL,
    embedding       vector NOT NULL,
    token_count     int NOT NULL,
    chunk_method    text NOT NULL,
    metadata        jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),

    UNIQUE(file_id, chunk_index)
);

-- Upload activity log: audit trail for dashboard timeline
CREATE TABLE kvec.upload_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id   uuid NOT NULL REFERENCES kvec.collections(id) ON DELETE CASCADE,
    snapshot_id     uuid REFERENCES kvec.snapshots(id),
    event_type      text NOT NULL,
    source_path     text,
    files_processed int NOT NULL DEFAULT 0,
    files_skipped   int NOT NULL DEFAULT 0,
    files_errored   int NOT NULL DEFAULT 0,
    chunks_created  int NOT NULL DEFAULT 0,
    chunks_deleted  int NOT NULL DEFAULT 0,
    duration_ms     int,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Indexes

-- tracked_files: dashboard filters
CREATE INDEX idx_kvec_tracked_files_collection ON kvec.tracked_files(collection_id);
CREATE INDEX idx_kvec_tracked_files_repo ON kvec.tracked_files(repo_id);
CREATE INDEX idx_kvec_tracked_files_status ON kvec.tracked_files(collection_id, status);
CREATE INDEX idx_kvec_tracked_files_language ON kvec.tracked_files(collection_id, language);

-- chunks: file lookup
CREATE INDEX idx_kvec_chunks_file ON kvec.chunks(file_id);

-- upload_events: timeline
CREATE INDEX idx_kvec_upload_events_collection ON kvec.upload_events(collection_id, created_at DESC);

-- snapshots: repo lookup
CREATE INDEX idx_kvec_snapshots_repo ON kvec.snapshots(repo_id);

-- Views

-- Per-file stats (chunk_count, token_count derived from chunks table)
CREATE VIEW kvec.tracked_files_stats AS
SELECT f.*,
    COUNT(c.id) AS chunk_count,
    COALESCE(SUM(c.token_count), 0) AS total_token_count,
    array_agg(DISTINCT c.chunk_method) FILTER (WHERE c.chunk_method IS NOT NULL) AS chunk_methods
FROM kvec.tracked_files f
LEFT JOIN kvec.chunks c ON c.file_id = f.id
GROUP BY f.id;

-- Collection dashboard summary
CREATE VIEW kvec.collection_stats AS
SELECT col.*,
    COUNT(DISTINCT f.id) AS file_count,
    COUNT(ch.id) AS total_chunks,
    COALESCE(SUM(DISTINCT f.file_size), 0) AS total_bytes,
    COUNT(DISTINCT r.id) AS repo_count,
    COUNT(DISTINCT s.branch) AS branch_count,
    MAX(f.updated_at) AS last_upload
FROM kvec.collections col
LEFT JOIN kvec.tracked_files f ON f.collection_id = col.id
LEFT JOIN kvec.chunks ch ON ch.file_id = f.id
LEFT JOIN kvec.repos r ON r.collection_id = col.id
LEFT JOIN kvec.snapshots s ON s.id = f.snapshot_id
GROUP BY col.id;

-- DOWN

DROP VIEW IF EXISTS kvec.collection_stats;
DROP VIEW IF EXISTS kvec.tracked_files_stats;
DROP TABLE IF EXISTS kvec.upload_events;
DROP TABLE IF EXISTS kvec.chunks;
DROP TABLE IF EXISTS kvec.tracked_files;
DROP TABLE IF EXISTS kvec.snapshots;
DROP TABLE IF EXISTS kvec.repos;
DROP TABLE IF EXISTS kvec.collections;
DROP SCHEMA IF EXISTS kvec;
