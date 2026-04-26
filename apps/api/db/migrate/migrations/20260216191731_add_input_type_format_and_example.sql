-- Migration: Add format hint to input types and example to definition inputs
-- Created: 2026-02-16

-- UP

ALTER TABLE kdag.input_types ADD COLUMN format VARCHAR(30);
ALTER TABLE kdag.job_definition_inputs ADD COLUMN example TEXT;

-- Backfill built-in input types with text format
UPDATE kdag.input_types SET format = 'text' WHERE key IN ('prompt', 'chunk_prompt', 'system_prompt', 'transcript', 'existing_summary');

-- DOWN

ALTER TABLE kdag.job_definition_inputs DROP COLUMN example;
ALTER TABLE kdag.input_types DROP COLUMN format;
