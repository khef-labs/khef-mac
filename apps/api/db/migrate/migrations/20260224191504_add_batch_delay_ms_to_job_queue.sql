-- Migration: Add batch_delay_ms column to kdag.job_queue
-- Created: 2026-02-24T19:15:04Z

-- UP
ALTER TABLE kdag.job_queue ADD COLUMN batch_delay_ms integer;

-- DOWN
ALTER TABLE kdag.job_queue DROP COLUMN batch_delay_ms;
