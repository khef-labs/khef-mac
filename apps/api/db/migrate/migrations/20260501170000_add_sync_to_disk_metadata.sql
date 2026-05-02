-- Migration: Add sync_to_disk metadata field and retire `inactive` status for sync-relevant types
--
-- Replaces the dual meaning of `inactive` ("don't auto-import into CLAUDE.md") with a
-- dedicated `sync_to_disk` metadata flag. Status values revert to their semantic life-cycle
-- meaning (active/deprecated/etc.). Affects assistant-rule, commands, context, pattern.

-- UP

-- 1. Register the new metadata field
INSERT INTO metadata (entity_type, field, description, value_type, default_value)
VALUES (
  'memory',
  'sync_to_disk',
  'When false, exclude this memory from disk sync (KF-RULES.md / KF-PROJECT-KNOWLEDGE.md auto-import). Content remains searchable.',
  'boolean',
  'true'
)
ON CONFLICT (entity_type, field) DO NOTHING;

-- 2. For every currently-inactive memory of the four sync-relevant types,
--    set sync_to_disk='false' and flip status back to its semantic-active equivalent.
WITH target_types AS (
  SELECT id, name FROM memory_types
  WHERE name IN ('assistant-rule', 'commands', 'context', 'pattern')
),
inactive_memories AS (
  SELECT m.id AS memory_id, mt.name AS type_name
  FROM memories m
  JOIN target_types mt ON mt.id = m.memory_type_id
  JOIN memory_type_statuses mts ON mts.id = m.status_id
  WHERE mts.status_value = 'inactive'
),
md AS (
  SELECT id FROM metadata WHERE entity_type = 'memory' AND field = 'sync_to_disk'
)
INSERT INTO memory_metadata (memory_id, metadata_id, value)
SELECT im.memory_id, md.id, 'false'
FROM inactive_memories im
CROSS JOIN md
ON CONFLICT (memory_id, metadata_id) DO UPDATE SET value = 'false', updated_at = NOW();

-- 3. Flip each memory's status to the type's semantic-active equivalent.
--    assistant-rule -> active, commands -> verified, context -> current, pattern -> active
UPDATE memories m
SET status_id = mts_target.id, status_updated_at = NOW()
FROM memory_types mt
JOIN memory_type_statuses mts_current ON mts_current.memory_type_id = mt.id AND mts_current.status_value = 'inactive'
JOIN memory_type_statuses mts_target ON mts_target.memory_type_id = mt.id AND mts_target.status_value = CASE mt.name
  WHEN 'assistant-rule' THEN 'active'
  WHEN 'commands' THEN 'verified'
  WHEN 'context' THEN 'current'
  WHEN 'pattern' THEN 'active'
END
WHERE m.memory_type_id = mt.id
  AND m.status_id = mts_current.id
  AND mt.name IN ('assistant-rule', 'commands', 'context', 'pattern');

-- 4. Drop `inactive` from memory_type_statuses for those four types.
--    Safe now that no memory references those rows.
DELETE FROM memory_type_statuses mts
USING memory_types mt
WHERE mts.memory_type_id = mt.id
  AND mts.status_value = 'inactive'
  AND mt.name IN ('assistant-rule', 'commands', 'context', 'pattern');

-- DOWN

-- Re-add `inactive` status rows for the four types (sort_order 10 matches the prior seed).
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, sort_order)
SELECT mt.id, 'inactive', 'Inactive', 10
FROM memory_types mt
WHERE mt.name IN ('assistant-rule', 'commands', 'context', 'pattern')
ON CONFLICT (memory_type_id, status_value) DO NOTHING;

-- Restore `inactive` status on memories that had sync_to_disk=false set by the UP migration.
UPDATE memories m
SET status_id = mts_inactive.id, status_updated_at = NOW()
FROM memory_types mt
JOIN memory_type_statuses mts_inactive ON mts_inactive.memory_type_id = mt.id AND mts_inactive.status_value = 'inactive'
JOIN memory_metadata mm ON mm.memory_id = m.id
JOIN metadata md ON md.id = mm.metadata_id AND md.field = 'sync_to_disk' AND md.entity_type = 'memory'
WHERE m.memory_type_id = mt.id
  AND mt.name IN ('assistant-rule', 'commands', 'context', 'pattern')
  AND mm.value = 'false';

-- Remove the metadata field and any per-memory overrides
DELETE FROM memory_metadata
WHERE metadata_id = (SELECT id FROM metadata WHERE entity_type = 'memory' AND field = 'sync_to_disk');
DELETE FROM metadata WHERE entity_type = 'memory' AND field = 'sync_to_disk';
