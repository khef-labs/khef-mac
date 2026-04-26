-- Migration: Move job tables to kdag schema
-- Isolates the job orchestration subsystem into its own schema.
-- session_summaries and session_summary_snapshots stay in public (session artifacts).

-- UP

CREATE SCHEMA IF NOT EXISTS kdag;

-- Move tables in dependency order (leaves first, roots last)
-- Note: ALTER TABLE SET SCHEMA moves the table, its indexes, and sequences.
-- Foreign key constraints are tracked by OID so cross-schema refs keep working.

-- Leaf tables first
ALTER TABLE job_outputs SET SCHEMA kdag;
ALTER TABLE job_steps SET SCHEMA kdag;

-- Mid-level
ALTER TABLE job_runs SET SCHEMA kdag;
ALTER TABLE job_inputs SET SCHEMA kdag;
ALTER TABLE job_definition_inputs SET SCHEMA kdag;
ALTER TABLE job_definition_steps SET SCHEMA kdag;

-- Core
ALTER TABLE jobs SET SCHEMA kdag;
ALTER TABLE job_definitions SET SCHEMA kdag;

-- Enum/lookup tables
ALTER TABLE job_types SET SCHEMA kdag;
ALTER TABLE input_types SET SCHEMA kdag;
ALTER TABLE output_formats SET SCHEMA kdag;

-- Recreate the view in kdag schema referencing the moved tables.
-- The old view in public references public.* table names which no longer exist.
DROP VIEW IF EXISTS job_run_results;

CREATE VIEW kdag.job_run_results AS
SELECT
  jr.id AS run_id,
  j.id AS job_id,
  jt.key AS job_type,
  jr.status,
  jr.model,
  jr.exit_code,
  jr.error,
  jr.duration_ms,
  a.handle AS assistant_handle,
  p.handle AS project_handle,
  p.name AS project_name,
  j.requested_by,
  (SELECT string_agg(it.key || ':' || length(coalesce(ji.content,''))::text, ', ' ORDER BY it.key)
   FROM kdag.job_inputs ji JOIN kdag.input_types it ON it.id = ji.input_type_id
   WHERE ji.job_id = j.id) AS inputs_summary,
  (SELECT jo.output_text FROM kdag.job_outputs jo
   WHERE jo.job_run_id = jr.id LIMIT 1) AS output_text,
  (SELECT of2.key FROM kdag.job_outputs jo2
   JOIN kdag.output_formats of2 ON of2.id = jo2.output_format_id
   WHERE jo2.job_run_id = jr.id LIMIT 1) AS output_format,
  (SELECT count(*)::int FROM kdag.job_steps js WHERE js.job_run_id = jr.id) AS step_count,
  (SELECT count(*)::int FROM kdag.job_steps js2 WHERE js2.job_run_id = jr.id AND js2.status = 'completed') AS steps_completed,
  jr.started_at,
  jr.completed_at,
  jr.created_at
FROM kdag.job_runs jr
JOIN kdag.jobs j ON j.id = jr.job_id
JOIN kdag.job_types jt ON jt.id = j.job_type_id
JOIN public.assistants a ON a.id = j.assistant_id
LEFT JOIN public.projects p ON p.id = j.project_id;

-- Fix the cross-schema FK: session_summary_snapshots.job_run_id → kdag.job_runs
-- The FK constraint still works after SET SCHEMA (tracked by OID), but let's
-- verify by checking it exists. No action needed — PostgreSQL handles this.

-- DOWN

-- Move everything back to public
ALTER TABLE kdag.job_outputs SET SCHEMA public;
ALTER TABLE kdag.job_steps SET SCHEMA public;
ALTER TABLE kdag.job_runs SET SCHEMA public;
ALTER TABLE kdag.job_inputs SET SCHEMA public;
ALTER TABLE kdag.job_definition_inputs SET SCHEMA public;
ALTER TABLE kdag.job_definition_steps SET SCHEMA public;
ALTER TABLE kdag.jobs SET SCHEMA public;
ALTER TABLE kdag.job_definitions SET SCHEMA public;
ALTER TABLE kdag.job_types SET SCHEMA public;
ALTER TABLE kdag.input_types SET SCHEMA public;
ALTER TABLE kdag.output_formats SET SCHEMA public;

-- Restore the view in public schema
DROP VIEW IF EXISTS kdag.job_run_results;

CREATE VIEW job_run_results AS
SELECT
  jr.id AS run_id,
  j.id AS job_id,
  jt.key AS job_type,
  jr.status,
  jr.model,
  jr.exit_code,
  jr.error,
  jr.duration_ms,
  a.handle AS assistant_handle,
  p.handle AS project_handle,
  p.name AS project_name,
  j.requested_by,
  (SELECT string_agg(it.key || ':' || length(coalesce(ji.content,''))::text, ', ' ORDER BY it.key)
   FROM job_inputs ji JOIN input_types it ON it.id = ji.input_type_id
   WHERE ji.job_id = j.id) AS inputs_summary,
  (SELECT jo.output_text FROM job_outputs jo
   WHERE jo.job_run_id = jr.id LIMIT 1) AS output_text,
  (SELECT of2.key FROM job_outputs jo2
   JOIN output_formats of2 ON of2.id = jo2.output_format_id
   WHERE jo2.job_run_id = jr.id LIMIT 1) AS output_format,
  (SELECT count(*)::int FROM job_steps js WHERE js.job_run_id = jr.id) AS step_count,
  (SELECT count(*)::int FROM job_steps js2 WHERE js2.job_run_id = jr.id AND js2.status = 'completed') AS steps_completed,
  jr.started_at,
  jr.completed_at,
  jr.created_at
FROM job_runs jr
JOIN jobs j ON j.id = jr.job_id
JOIN job_types jt ON jt.id = j.job_type_id
JOIN assistants a ON a.id = j.assistant_id
LEFT JOIN projects p ON p.id = j.project_id;

DROP SCHEMA IF EXISTS kdag;
