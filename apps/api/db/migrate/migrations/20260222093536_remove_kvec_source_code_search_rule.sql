-- Migration: Remove orphaned kvec-source-code-search rule (merged into search-khef-first)
-- Created: 2026-02-22T09:35:36-06:00

-- UP
DELETE FROM memory_tags WHERE memory_id IN (
  SELECT id FROM memories WHERE handle = 'kvec-source-code-search'
);
DELETE FROM memory_chunks WHERE memory_id IN (
  SELECT id FROM memories WHERE handle = 'kvec-source-code-search'
);
DELETE FROM memory_relations WHERE source_memory_id IN (
  SELECT id FROM memories WHERE handle = 'kvec-source-code-search'
) OR target_memory_id IN (
  SELECT id FROM memories WHERE handle = 'kvec-source-code-search'
);
DELETE FROM memories WHERE handle = 'kvec-source-code-search';

-- DOWN
-- No-op: the seed system will recreate the memory if the seed file is restored
