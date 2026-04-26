-- Migration: Fix updated_at trigger to allow explicit timestamps
-- Created: 2026-01-28T18:45:48.000Z
--
-- The trigger unconditionally overwrites updated_at, which breaks vector sync.
-- When we set embedding_generated_at = NOW(), updated_at = NOW() in the same
-- statement, the trigger fires AFTER and calls its own NOW(), resulting in
-- updated_at being slightly later than embedding_generated_at.
--
-- Fix: Only set updated_at if it wasn't explicitly changed in the UPDATE.

-- UP
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  -- Only auto-set if updated_at wasn't explicitly changed
  IF NEW.updated_at = OLD.updated_at THEN
    NEW.updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- DOWN
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
