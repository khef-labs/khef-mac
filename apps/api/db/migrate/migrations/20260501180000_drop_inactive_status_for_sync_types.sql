-- Migration: Drop `inactive` status from sync-relevant memory types
--
-- Companion cleanup to 20260501170000_add_sync_to_disk_metadata.sql. The seed
-- re-inserts memory_type_statuses on every db:seed run; the prior migration's
-- delete was undone immediately by the next seed. The seed file no longer
-- inserts these rows, so this migration deletes them once and they stay gone.
--
-- Safe to run because the prior migration already flipped every `inactive`
-- memory off this status.

-- UP

DELETE FROM memory_type_statuses mts
USING memory_types mt
WHERE mts.memory_type_id = mt.id
  AND mts.status_value = 'inactive'
  AND mt.name IN ('assistant-rule', 'commands', 'context', 'pattern');

-- DOWN

INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, 'inactive', 'Inactive', 'Memory is inactive', 10
FROM memory_types mt
WHERE mt.name IN ('assistant-rule', 'commands', 'context', 'pattern')
ON CONFLICT (memory_type_id, status_value) DO NOTHING;
