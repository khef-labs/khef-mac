-- Migration: Reclaim orphaned dbx saved queries
-- Created: 2026-05-01
--
-- "Built-in" is defined by the seed file in apps/api/db/seed/seeds/dbx_saved_queries.sql.
-- Any other row with owner_session_id = NULL is an orphan from an MCP create
-- that didn't pass session_id. Reclaim those by assigning a default owner so
-- they stop displaying as built-in. Also flips is_readonly off to match the
-- new "built-in ↔ read-only" alignment.
--
-- The seed file's UPDATE clause forces the three seeded handles back to
-- owner_session_id = NULL on every reseed, so this UPDATE never affects them.
--
-- Going forward, POST /api/dbx/saved-queries rejects requests without
-- owner_session_id (see route validation in apps/api/src/routes/dbx.ts), so
-- this should be a one-shot cleanup.

-- UP

UPDATE dbx.saved_queries
SET owner_session_id = 'khef-ui',
    is_readonly = false
WHERE owner_session_id IS NULL
  AND handle NOT IN (
    'memories-by-tag',
    'configs-by-path',
    'assistant-config-counts'
  );

-- DOWN

-- No reverse: original owner_session_id values are not preserved. The down
-- path leaves the reclaimed state in place.
