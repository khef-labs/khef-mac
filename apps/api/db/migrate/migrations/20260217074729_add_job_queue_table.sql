-- Migration: Add persistent job queue table
-- Created: 2026-02-17T07:47:29Z

-- UP
CREATE TABLE kdag.job_queue (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  job_id uuid NOT NULL REFERENCES kdag.jobs(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES kdag.job_runs(id) ON DELETE CASCADE,
  step_timeout_ms integer,
  is_retry boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_job_queue_created_at ON kdag.job_queue (created_at);

-- DOWN
DROP TABLE kdag.job_queue;
