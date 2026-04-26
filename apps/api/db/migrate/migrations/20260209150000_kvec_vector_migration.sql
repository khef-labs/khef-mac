-- Migrate vector embeddings from legacy Chroma/Qdrant to kvec (pgvector).
-- Resets vector_synced_at so the background worker re-embeds all memories into kvec.
-- Legacy tables are kept for now; a follow-up migration will drop them after verification.

-- UP

-- Reset all memories to trigger re-embedding into kvec
UPDATE memories SET vector_synced_at = NULL;

-- DOWN

-- No-op: re-embedding is idempotent, nothing to reverse
