-- Migration: Create view job_run_results
-- Created: 2026-02-11T15:00:00.000Z

-- UP

CREATE OR REPLACE VIEW job_run_results AS
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

-- DOWN

DROP VIEW IF EXISTS job_run_results;
