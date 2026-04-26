-- Migration: Add from_step column to job_queue for rerun-from-step support
-- Created: 2026-03-03T14:47:21Z

-- UP
ALTER TABLE kdag.job_queue ADD COLUMN from_step VARCHAR(255);

-- DOWN
ALTER TABLE kdag.job_queue DROP COLUMN from_step;
