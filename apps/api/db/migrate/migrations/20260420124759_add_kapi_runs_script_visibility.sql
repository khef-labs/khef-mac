-- Migration: Split script error + env_writes visibility on kapi.runs
-- Created: 2026-04-20T12:47:59.000Z
--
-- Currently kapi.runs.error concatenates the HTTP error with both script
-- errors (separated by ' | '), and env writes from pre/test scripts are
-- persisted to the active env but never attached to the run record. Hard
-- to debug: "why is my token empty?" has no audit trail.
--
-- Adds four columns so the UI can show each script's error and env_writes
-- distinctly on the response pane.

-- UP

ALTER TABLE kapi.runs
  ADD COLUMN pre_script_error TEXT,
  ADD COLUMN test_script_error TEXT,
  ADD COLUMN pre_script_env_writes JSONB,
  ADD COLUMN test_script_env_writes JSONB;

-- DOWN

ALTER TABLE kapi.runs
  DROP COLUMN pre_script_error,
  DROP COLUMN test_script_error,
  DROP COLUMN pre_script_env_writes,
  DROP COLUMN test_script_env_writes;
