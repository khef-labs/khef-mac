-- Migration: Delete stale dev-mem path templates from assistant_config_paths
-- Created: 2026-04-30T21:12:04.000Z
--
-- Some databases that pre-date the dev-mem → khef rename still carry
-- assistant_config_paths rows with path_template values containing "DM-"
-- (e.g. '{project}/DM-PROJECT-KNOWLEDGE.md'). The current seed migration
-- (20260129111751_add_knowledge_config_paths.sql) inserts the KF- form,
-- but if a DM- row already existed it would have been blocked by the
-- UNIQUE(assistant_id, scope, type) constraint and silently left in place.
-- Drop the stale rows outright. The KF- equivalents are seeded by the
-- earlier migrations on fresh databases; on databases that carried these
-- DM- rows over from dev-mem, deletion is the desired final state.

-- UP

DELETE FROM assistant_config_paths
WHERE path_template LIKE '%DM-%';

-- DOWN

-- No-op. Reverting would reintroduce stale dev-mem references and there
-- is no record of which rows existed before the cleanup.
SELECT 1;
