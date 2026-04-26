-- Migration: Prune Deleted Seed Path Metadata
-- Created: 2026-04-22T14:38:44.494Z
--
-- Removes the `seed-path` metadata entry from memories whose seed files were
-- deleted in commit f9b30fd (personal-preference user assistant-rule seeds).
-- After this migration, those memories become editable in the UI again and
-- stop showing the Seed badge / broken Open-in-editor link.
--
-- The memories themselves are preserved (they remain active user rules);
-- only the dangling seed-path metadata is removed.

-- UP

DELETE FROM memory_metadata
WHERE metadata_id = (
        SELECT id FROM metadata
        WHERE entity_type = 'memory' AND field = 'seed-path'
      )
  AND value IN (
    'apps/api/db/seed/memories/user/assistant-rule/02-git-safety-never-push-ask-first.md',
    'apps/api/db/seed/memories/user/assistant-rule/03-incident-bug-doc-workflow.md',
    'apps/api/db/seed/memories/user/assistant-rule/04-maintain-living-plan.md',
    'apps/api/db/seed/memories/user/assistant-rule/09-pre-commit-doc-updates.md',
    'apps/api/db/seed/memories/user/assistant-rule/13-testing-expectations.md',
    'apps/api/db/seed/memories/user/assistant-rule/21-git-guard.md'
  );

-- DOWN

-- No-op. Restoring a deleted seed-path would require re-associating each value
-- with the correct memory_id, which cannot be derived from this migration
-- alone. If rollback is needed, re-run `npm run db:seed:sync` after restoring
-- the deleted seed files from git history.
