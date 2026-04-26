-- Drop the current_snapshot column from memories.
-- This value is now computed as MAX(snapshot_number) + 1 from memory_snapshots.

ALTER TABLE memories DROP COLUMN IF EXISTS current_snapshot;

-- DOWN

ALTER TABLE memories ADD COLUMN current_snapshot INT DEFAULT 1;
