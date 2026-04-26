-- Migration: Add notes column to configs
-- Created: 2026-03-04T17:40:33Z

-- UP
ALTER TABLE configs ADD COLUMN notes TEXT;

-- DOWN
ALTER TABLE configs DROP COLUMN notes;
