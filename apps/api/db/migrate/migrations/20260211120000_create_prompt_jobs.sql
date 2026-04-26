-- Migration: Create job system (3NF) — job_types, jobs, job_runs, inputs, outputs, steps, session summaries
-- Created: 2026-02-11T12:00:00Z

-- UP

-- Lookup: job types
CREATE TABLE job_types (
  id SERIAL PRIMARY KEY,
  key VARCHAR(50) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO job_types (key, description) VALUES
  ('session_summary', 'Summarize a synced session transcript'),
  ('custom', 'Run a custom prompt');

-- Lookup: input types
CREATE TABLE input_types (
  id SERIAL PRIMARY KEY,
  key VARCHAR(50) NOT NULL UNIQUE,
  description TEXT
);

INSERT INTO input_types (key, description) VALUES
  ('prompt', 'Prompt text sent to the model'),
  ('chunk_prompt', 'Prompt for summarizing individual chunks in map-reduce'),
  ('system_prompt', 'System prompt override'),
  ('transcript', 'Session transcript content'),
  ('existing_summary', 'Previous summary to update incrementally');

-- Lookup: output formats
CREATE TABLE output_formats (
  id SERIAL PRIMARY KEY,
  key VARCHAR(30) NOT NULL UNIQUE,
  description TEXT
);

INSERT INTO output_formats (key, description) VALUES
  ('text', 'Plain text output'),
  ('json', 'JSON output'),
  ('markdown', 'Markdown output');

-- Seed: Gemini assistant (Claude and Codex seeded in assistant_config_tables migration)
INSERT INTO assistants (handle, name, description) VALUES
  ('gemini', 'Gemini', 'Google Gemini via Vertex AI')
ON CONFLICT (handle) DO NOTHING;

-- Core: jobs (what to do)
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  job_type_id INT NOT NULL REFERENCES job_types(id),
  assistant_id UUID NOT NULL REFERENCES assistants(id),
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  requested_by VARCHAR(20) DEFAULT 'ui',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jobs_job_type_id ON jobs(job_type_id);
CREATE INDEX idx_jobs_project_id ON jobs(project_id);
CREATE INDEX idx_jobs_created_at ON jobs(created_at DESC);

-- Inputs: polymorphic inputs per job
CREATE TABLE job_inputs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  input_type_id INT NOT NULL REFERENCES input_types(id),
  content TEXT,
  ref_type VARCHAR(30),
  ref_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_inputs_job_id ON job_inputs(job_id);

-- Runs: each execution attempt
CREATE TABLE job_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  model VARCHAR(100),
  cli_flags JSONB,
  exit_code INT,
  error TEXT,
  duration_ms INT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_runs_job_id ON job_runs(job_id);
CREATE INDEX idx_job_runs_status ON job_runs(status);

-- Outputs: result per run
CREATE TABLE job_outputs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  job_run_id UUID NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  output_format_id INT NOT NULL REFERENCES output_formats(id),
  output_text TEXT,
  output_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_outputs_job_run_id ON job_outputs(job_run_id);

-- Steps: checkpoints within a run (map-reduce batches)
CREATE TABLE job_steps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  job_run_id UUID NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  step_index INT NOT NULL,
  step_type VARCHAR(30) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  input_chars INT,
  output_text TEXT,
  duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_run_id, step_index)
);

CREATE INDEX idx_job_steps_job_run_id ON job_steps(job_run_id);

-- Session summary snapshots: one per run that produces a summary
CREATE TABLE session_summary_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  job_run_id UUID NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_session_summary_snapshots_session_id ON session_summary_snapshots(session_id);

-- Session summaries: pointer to current snapshot
CREATE TABLE session_summaries (
  session_id UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  current_snapshot_id UUID NOT NULL REFERENCES session_summary_snapshots(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- DOWN

DROP TABLE IF EXISTS session_summaries;
DROP TABLE IF EXISTS session_summary_snapshots;
DROP TABLE IF EXISTS job_steps;
DROP TABLE IF EXISTS job_outputs;
DROP TABLE IF EXISTS job_runs;
DROP TABLE IF EXISTS job_inputs;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS output_formats;
DROP TABLE IF EXISTS input_types;
DROP TABLE IF EXISTS job_types;
DELETE FROM assistants WHERE handle = 'gemini';
