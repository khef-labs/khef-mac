-- Migration: Add board_config JSONB column to collections
-- Stores per-collection board view preferences (hidden columns, etc.)

-- UP

ALTER TABLE collections
  ADD COLUMN board_config JSONB NOT NULL DEFAULT '{}';

-- DOWN

ALTER TABLE collections DROP COLUMN IF EXISTS board_config;
