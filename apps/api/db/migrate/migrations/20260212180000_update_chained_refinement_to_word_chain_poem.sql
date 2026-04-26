-- Migration: Update chained-refinement definition to Word Chain Poem
-- Created: 2026-02-12

-- UP

-- Update definition metadata
UPDATE kdag.job_definitions
SET name = 'Word Chain Poem',
    description = 'Find synonyms, then antonyms, then compose a poem from the results',
    updated_at = NOW()
WHERE key = 'chained-refinement';

-- Remove old steps
DELETE FROM kdag.job_definition_steps
WHERE definition_id = (SELECT id FROM kdag.job_definitions WHERE key = 'chained-refinement');

-- Insert new steps with prompt handles
INSERT INTO kdag.job_definition_steps (definition_id, step_index, key, name, step_type, assistant_handle, prompt_handle, input_source, input_config, timeout_ms)
SELECT jd.id, 0, 'synonyms', 'Find Synonyms', 'prompt', 'claude-code', 'find-synonyms', 'job_input',
  '{"input_type": "prompt"}'::jsonb, 120000
FROM kdag.job_definitions jd WHERE jd.key = 'chained-refinement';

INSERT INTO kdag.job_definition_steps (definition_id, step_index, key, name, step_type, assistant_handle, prompt_handle, input_source, input_config, timeout_ms)
SELECT jd.id, 1, 'antonyms', 'Find Antonyms', 'prompt', 'claude-code', 'find-antonyms', 'previous_step',
  '{"step_key": "synonyms"}'::jsonb, 120000
FROM kdag.job_definitions jd WHERE jd.key = 'chained-refinement';

INSERT INTO kdag.job_definition_steps (definition_id, step_index, key, name, step_type, assistant_handle, prompt_handle, input_source, input_config, timeout_ms)
SELECT jd.id, 2, 'poem', 'Compose Poem', 'prompt', 'claude-code', 'compose-poem', 'previous_step',
  '{"step_key": "antonyms"}'::jsonb, 120000
FROM kdag.job_definitions jd WHERE jd.key = 'chained-refinement';

-- DOWN

-- Restore original chained-refinement (Draft/Refine)
UPDATE kdag.job_definitions
SET name = 'Chained Refinement',
    description = 'Draft with a fast model, then polish with a stronger one',
    updated_at = NOW()
WHERE key = 'chained-refinement';

DELETE FROM kdag.job_definition_steps
WHERE definition_id = (SELECT id FROM kdag.job_definitions WHERE key = 'chained-refinement');

INSERT INTO kdag.job_definition_steps (definition_id, step_index, key, name, step_type, assistant_handle, input_source, input_config, timeout_ms)
SELECT jd.id, 0, 'draft', 'Draft', 'prompt', 'gemini', 'job_input', '{"input_type": "prompt"}'::jsonb, 120000
FROM kdag.job_definitions jd WHERE jd.key = 'chained-refinement';

INSERT INTO kdag.job_definition_steps (definition_id, step_index, key, name, step_type, assistant_handle, input_source, input_config, timeout_ms)
SELECT jd.id, 1, 'refine', 'Refine', 'prompt', 'claude-code', 'previous_step', '{"step_key": "draft"}'::jsonb, 120000
FROM kdag.job_definitions jd WHERE jd.key = 'chained-refinement';
