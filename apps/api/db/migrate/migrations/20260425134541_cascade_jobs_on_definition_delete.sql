-- Migration: Cascade jobs when a kdag definition is deleted
-- Replaces the existing FK on kdag.jobs.definition_id with ON DELETE CASCADE
-- so deleting a job_definitions row removes all jobs (and their runs, steps,
-- inputs, outputs, queue rows) created from it.
-- Created: 2026-04-25

-- UP

ALTER TABLE kdag.jobs DROP CONSTRAINT jobs_definition_id_fkey;
ALTER TABLE kdag.jobs ADD CONSTRAINT jobs_definition_id_fkey
  FOREIGN KEY (definition_id) REFERENCES kdag.job_definitions(id) ON DELETE CASCADE;

-- DOWN

ALTER TABLE kdag.jobs DROP CONSTRAINT jobs_definition_id_fkey;
ALTER TABLE kdag.jobs ADD CONSTRAINT jobs_definition_id_fkey
  FOREIGN KEY (definition_id) REFERENCES kdag.job_definitions(id);
