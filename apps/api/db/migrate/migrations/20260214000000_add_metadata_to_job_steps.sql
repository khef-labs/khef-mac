-- Migration: Add metadata JSONB column to kdag.job_steps
-- Created: 2026-02-14T00:00:00Z

-- UP
ALTER TABLE kdag.job_steps ADD COLUMN metadata jsonb;

-- DOWN
ALTER TABLE kdag.job_steps DROP COLUMN metadata;
