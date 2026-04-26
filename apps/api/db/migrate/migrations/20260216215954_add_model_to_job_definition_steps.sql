-- Migration: Add model column to job_definition_steps
-- Created: 2026-02-16T21:59:54Z

-- UP
ALTER TABLE kdag.job_definition_steps ADD COLUMN model varchar(100);

-- DOWN
ALTER TABLE kdag.job_definition_steps DROP COLUMN model;
