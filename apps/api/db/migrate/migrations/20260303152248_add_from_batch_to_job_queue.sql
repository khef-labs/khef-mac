-- Migration: Add from_batch column to job_queue for batch-level rerun
-- Created: 2026-03-03T15:22:48Z

-- UP
ALTER TABLE kdag.job_queue ADD COLUMN from_batch INTEGER;

-- DOWN
ALTER TABLE kdag.job_queue DROP COLUMN from_batch;
