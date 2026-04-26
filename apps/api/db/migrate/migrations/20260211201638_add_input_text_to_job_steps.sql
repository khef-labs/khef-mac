-- Migration: Add input_text to job_steps
-- Created: 2026-02-11

-- UP
ALTER TABLE job_steps ADD COLUMN input_text TEXT;

-- DOWN
ALTER TABLE job_steps DROP COLUMN input_text;
