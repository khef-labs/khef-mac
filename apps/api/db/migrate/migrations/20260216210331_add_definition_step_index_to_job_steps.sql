-- Migration: Add definition_step_index column to kdag.job_steps
-- Created: 2026-02-16T21:03:31Z
--
-- Fixes step index collision bug where map_reduce sub-steps (batch + synthesis)
-- occupy indices that collide with subsequent definition steps.
-- The new column tracks which definition step a job_step belongs to,
-- while step_index becomes a local counter within that scope.

-- UP

-- 1. Drop old constraint first (backfill will temporarily create collisions)
ALTER TABLE kdag.job_steps DROP CONSTRAINT job_steps_job_run_id_step_index_key;

-- 2. Add column (nullable for backfill)
ALTER TABLE kdag.job_steps ADD COLUMN definition_step_index integer;

-- 3. Backfill: definition-driven jobs with *1000 convention (step_index >= 1000)
UPDATE kdag.job_steps js
SET definition_step_index = js.step_index / 1000,
    step_index = js.step_index % 1000
FROM kdag.job_runs jr
JOIN kdag.jobs j ON j.id = jr.job_id
WHERE js.job_run_id = jr.id
  AND j.definition_id IS NOT NULL
  AND js.step_index >= 1000;

-- 4. Backfill: definition-driven jobs without *1000 convention (step_index < 1000)
--    Each step maps to its own definition step, local index = 0
UPDATE kdag.job_steps js
SET definition_step_index = js.step_index,
    step_index = 0
FROM kdag.job_runs jr
JOIN kdag.jobs j ON j.id = jr.job_id
WHERE js.job_run_id = jr.id
  AND j.definition_id IS NOT NULL
  AND js.definition_step_index IS NULL;

-- 5. Backfill: legacy jobs (no definition) — all belong to definition step 0
UPDATE kdag.job_steps
SET definition_step_index = 0
WHERE definition_step_index IS NULL;

-- 6. Make NOT NULL with default
ALTER TABLE kdag.job_steps ALTER COLUMN definition_step_index SET NOT NULL;
ALTER TABLE kdag.job_steps ALTER COLUMN definition_step_index SET DEFAULT 0;

-- 7. Add new composite unique constraint
ALTER TABLE kdag.job_steps ADD CONSTRAINT job_steps_run_def_step_unique
  UNIQUE (job_run_id, definition_step_index, step_index);

-- DOWN

-- Restore old step_index values from definition_step_index
-- Definition-driven sub-steps (step_index > 0 or batch/synthesis types): use *1000 convention
-- Other definition-driven steps: definition_step_index becomes step_index
-- Legacy: step_index is already correct (definition_step_index = 0)
UPDATE kdag.job_steps js
SET step_index = CASE
  WHEN js.step_index > 0 OR js.step_type IN ('batch_summary', 'synthesis')
    THEN js.definition_step_index * 1000 + js.step_index
  ELSE js.definition_step_index
END
FROM kdag.job_runs jr
JOIN kdag.jobs j ON j.id = jr.job_id
WHERE js.job_run_id = jr.id
  AND j.definition_id IS NOT NULL;

ALTER TABLE kdag.job_steps DROP CONSTRAINT job_steps_run_def_step_unique;
ALTER TABLE kdag.job_steps ADD CONSTRAINT job_steps_job_run_id_step_index_key
  UNIQUE (job_run_id, step_index);

ALTER TABLE kdag.job_steps DROP COLUMN definition_step_index;
