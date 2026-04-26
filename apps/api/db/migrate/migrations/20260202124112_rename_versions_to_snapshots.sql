-- Migration: Rename versions to snapshots for clearer terminology
-- Renames table memory_versions -> memory_snapshots
-- Renames column current_version -> current_snapshot in memories table
-- Renames column version -> snapshot_number in memory_snapshots table

-- UP

-- Rename the table (if needed)
DO $$
BEGIN
  IF to_regclass('public.memory_snapshots') IS NULL
     AND to_regclass('public.memory_versions') IS NOT NULL THEN
    ALTER TABLE memory_versions RENAME TO memory_snapshots;
  END IF;
END $$;

-- Rename column in memories table (if needed)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'current_version'
  ) THEN
    ALTER TABLE memories RENAME COLUMN current_version TO current_snapshot;
  END IF;
END $$;

-- Rename column in memory_snapshots table (if needed)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memory_snapshots' AND column_name = 'version'
  ) THEN
    ALTER TABLE memory_snapshots RENAME COLUMN version TO snapshot_number;
  END IF;
END $$;

-- DOWN

-- Rename column back in memory_snapshots table (if needed)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memory_snapshots' AND column_name = 'snapshot_number'
  ) THEN
    ALTER TABLE memory_snapshots RENAME COLUMN snapshot_number TO version;
  END IF;
END $$;

-- Rename column back in memories table (if needed)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'current_snapshot'
  ) THEN
    ALTER TABLE memories RENAME COLUMN current_snapshot TO current_version;
  END IF;
END $$;

-- Rename the table back (if needed)
DO $$
BEGIN
  IF to_regclass('public.memory_versions') IS NULL
     AND to_regclass('public.memory_snapshots') IS NOT NULL THEN
    ALTER TABLE memory_snapshots RENAME TO memory_versions;
  END IF;
END $$;
