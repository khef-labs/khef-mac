-- Migration: Create job definitions (reusable pipeline blueprints)
-- Created: 2026-02-11

-- UP

-- Job definitions: reusable pipeline blueprints
CREATE TABLE job_definitions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  key VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Definition steps: ordered steps within a pipeline
CREATE TABLE job_definition_steps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  definition_id UUID NOT NULL REFERENCES job_definitions(id) ON DELETE CASCADE,
  step_index INT NOT NULL,
  key VARCHAR(50) NOT NULL,
  name VARCHAR(200) NOT NULL,
  step_type VARCHAR(30) NOT NULL DEFAULT 'prompt',
  assistant_handle VARCHAR(50),
  prompt_handle VARCHAR(100),
  input_source VARCHAR(30) NOT NULL DEFAULT 'job_input',
  input_config JSONB NOT NULL DEFAULT '{}',
  config JSONB NOT NULL DEFAULT '{}',
  timeout_ms INT DEFAULT 120000,
  UNIQUE(definition_id, step_index),
  UNIQUE(definition_id, key)
);

CREATE INDEX idx_job_definition_steps_definition_id ON job_definition_steps(definition_id);

-- Definition inputs: declares required/optional inputs
CREATE TABLE job_definition_inputs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  definition_id UUID NOT NULL REFERENCES job_definitions(id) ON DELETE CASCADE,
  input_type_id INT NOT NULL REFERENCES input_types(id),
  required BOOLEAN NOT NULL DEFAULT true,
  description TEXT,
  UNIQUE(definition_id, input_type_id)
);

CREATE INDEX idx_job_definition_inputs_definition_id ON job_definition_inputs(definition_id);

-- Add definition_id to jobs
ALTER TABLE jobs ADD COLUMN definition_id UUID REFERENCES job_definitions(id);
CREATE INDEX idx_jobs_definition_id ON jobs(definition_id);

-- Seed system definitions

-- 1. session-summary: map-reduce for large session transcripts
INSERT INTO job_definitions (key, name, description, is_system) VALUES
  ('session-summary', 'Session Summary', 'Summarize a synced session transcript using map-reduce for large sessions', true),
  ('custom', 'Custom Prompt', 'Run a custom prompt through a single LLM call', true);

-- session-summary step
INSERT INTO job_definition_steps (definition_id, step_index, key, name, step_type, prompt_handle, input_source, input_config, config)
SELECT
  jd.id,
  0,
  'summarize',
  'Summarize Transcript',
  'map_reduce',
  'summarize-session',
  'job_input',
  '{"input_type": "transcript"}'::jsonb,
  '{"chunk_size": 50000, "threshold": 100000, "batch_prompt_handle": "summarize-session-chunk", "merge_template": "## Segment {{index}}\n\n{{output}}"}'::jsonb
FROM job_definitions jd WHERE jd.key = 'session-summary';

-- session-summary required inputs
INSERT INTO job_definition_inputs (definition_id, input_type_id, required, description)
SELECT jd.id, it.id, true, 'Synthesis prompt for the final summary'
FROM job_definitions jd, input_types it
WHERE jd.key = 'session-summary' AND it.key = 'prompt';

INSERT INTO job_definition_inputs (definition_id, input_type_id, required, description)
SELECT jd.id, it.id, true, 'Session transcript content'
FROM job_definitions jd, input_types it
WHERE jd.key = 'session-summary' AND it.key = 'transcript';

INSERT INTO job_definition_inputs (definition_id, input_type_id, required, description)
SELECT jd.id, it.id, true, 'Prompt for summarizing individual chunks'
FROM job_definitions jd, input_types it
WHERE jd.key = 'session-summary' AND it.key = 'chunk_prompt';

INSERT INTO job_definition_inputs (definition_id, input_type_id, required, description)
SELECT jd.id, it.id, false, 'Previous summary for incremental updates'
FROM job_definitions jd, input_types it
WHERE jd.key = 'session-summary' AND it.key = 'existing_summary';

-- custom step
INSERT INTO job_definition_steps (definition_id, step_index, key, name, step_type, input_source, input_config)
SELECT
  jd.id,
  0,
  'execute',
  'Execute Prompt',
  'prompt',
  'job_input',
  '{"input_type": "prompt"}'::jsonb
FROM job_definitions jd WHERE jd.key = 'custom';

-- custom required inputs
INSERT INTO job_definition_inputs (definition_id, input_type_id, required, description)
SELECT jd.id, it.id, true, 'Prompt text to execute'
FROM job_definitions jd, input_types it
WHERE jd.key = 'custom' AND it.key = 'prompt';

-- Backfill existing jobs with definition_id
UPDATE jobs SET definition_id = (
  SELECT jd.id FROM job_definitions jd
  JOIN job_types jt ON (
    CASE WHEN jt.key = 'session_summary' THEN 'session-summary'
         WHEN jt.key = 'custom' THEN 'custom'
    END = jd.key
  )
  WHERE jt.id = jobs.job_type_id
);

-- DOWN

ALTER TABLE jobs DROP COLUMN definition_id;
DROP TABLE IF EXISTS job_definition_inputs;
DROP TABLE IF EXISTS job_definition_steps;
DROP TABLE IF EXISTS job_definitions;
