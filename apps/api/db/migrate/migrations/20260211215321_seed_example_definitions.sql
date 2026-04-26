-- Migration: Seed example pipeline definitions
-- Created: 2026-02-11

-- UP

-- Chained Refinement: draft with a fast model, refine with a strong one
INSERT INTO job_definitions (key, name, description, is_system) VALUES
  ('chained-refinement', 'Chained Refinement', 'Draft with a fast model, then polish with a stronger one', false);

INSERT INTO job_definition_steps (definition_id, step_index, key, name, step_type, assistant_handle, input_source, input_config, timeout_ms)
SELECT jd.id, 0, 'draft', 'Draft', 'prompt', 'gemini', 'job_input', '{"input_type": "prompt"}'::jsonb, 120000
FROM job_definitions jd WHERE jd.key = 'chained-refinement';

INSERT INTO job_definition_steps (definition_id, step_index, key, name, step_type, assistant_handle, input_source, input_config, timeout_ms)
SELECT jd.id, 1, 'refine', 'Refine', 'prompt', 'claude-code', 'previous_step', '{"step_key": "draft"}'::jsonb, 120000
FROM job_definitions jd WHERE jd.key = 'chained-refinement';

INSERT INTO job_definition_inputs (definition_id, input_type_id, required, description)
SELECT jd.id, it.id, true, 'Prompt describing what to draft'
FROM job_definitions jd, input_types it
WHERE jd.key = 'chained-refinement' AND it.key = 'prompt';


-- Multi-Agent Comparison: run the same prompt through multiple agents, then compare
INSERT INTO job_definitions (key, name, description, is_system) VALUES
  ('multi-agent-comparison', 'Multi-Agent Comparison', 'Run the same prompt through Claude, Gemini, and Codex, then synthesize a comparison', false);

INSERT INTO job_definition_steps (definition_id, step_index, key, name, step_type, assistant_handle, input_source, input_config, timeout_ms)
SELECT jd.id, 0, 'claude-run', 'Claude', 'prompt', 'claude-code', 'job_input', '{"input_type": "prompt"}'::jsonb, 300000
FROM job_definitions jd WHERE jd.key = 'multi-agent-comparison';

INSERT INTO job_definition_steps (definition_id, step_index, key, name, step_type, assistant_handle, input_source, input_config, timeout_ms)
SELECT jd.id, 1, 'gemini-run', 'Gemini', 'prompt', 'gemini', 'job_input', '{"input_type": "prompt"}'::jsonb, 300000
FROM job_definitions jd WHERE jd.key = 'multi-agent-comparison';

INSERT INTO job_definition_steps (definition_id, step_index, key, name, step_type, assistant_handle, input_source, input_config, timeout_ms)
SELECT jd.id, 2, 'codex-run', 'Codex', 'prompt', 'codex-cli', 'job_input', '{"input_type": "prompt"}'::jsonb, 300000
FROM job_definitions jd WHERE jd.key = 'multi-agent-comparison';

INSERT INTO job_definition_steps (definition_id, step_index, key, name, step_type, assistant_handle, input_source, input_config, timeout_ms)
SELECT jd.id, 3, 'compare', 'Compare', 'prompt', 'claude-code', 'template',
  '{"template": "Compare these three responses to the same prompt and analyze their strengths, weaknesses, and differences.\n\n## Claude\n\n{{step.claude-run}}\n\n## Gemini\n\n{{step.gemini-run}}\n\n## Codex\n\n{{step.codex-run}}"}'::jsonb,
  300000
FROM job_definitions jd WHERE jd.key = 'multi-agent-comparison';

INSERT INTO job_definition_inputs (definition_id, input_type_id, required, description)
SELECT jd.id, it.id, true, 'Prompt to send to all three agents'
FROM job_definitions jd, input_types it
WHERE jd.key = 'multi-agent-comparison' AND it.key = 'prompt';


-- Extract and Create: summarize a session, then extract structured decisions/actions
INSERT INTO job_definitions (key, name, description, is_system) VALUES
  ('extract-and-create', 'Extract & Create', 'Summarize a session transcript, then extract decisions and action items as structured output', false);

INSERT INTO job_definition_steps (definition_id, step_index, key, name, step_type, prompt_handle, input_source, input_config, config, timeout_ms)
SELECT jd.id, 0, 'summarize', 'Summarize', 'map_reduce', 'summarize-session', 'job_input',
  '{"input_type": "transcript"}'::jsonb,
  '{"chunk_size": 50000, "threshold": 100000, "batch_prompt_handle": "summarize-session-chunk", "merge_template": "## Segment {{index}}\n\n{{output}}"}'::jsonb,
  120000
FROM job_definitions jd WHERE jd.key = 'extract-and-create';

INSERT INTO job_definition_steps (definition_id, step_index, key, name, step_type, input_source, input_config, timeout_ms)
SELECT jd.id, 1, 'extract', 'Extract Decisions & Actions', 'prompt', 'previous_step',
  '{"step_key": "summarize"}'::jsonb, 120000
FROM job_definitions jd WHERE jd.key = 'extract-and-create';

INSERT INTO job_definition_inputs (definition_id, input_type_id, required, description)
SELECT jd.id, it.id, true, 'Synthesis prompt for the summary step'
FROM job_definitions jd, input_types it
WHERE jd.key = 'extract-and-create' AND it.key = 'prompt';

INSERT INTO job_definition_inputs (definition_id, input_type_id, required, description)
SELECT jd.id, it.id, true, 'Session transcript to analyze'
FROM job_definitions jd, input_types it
WHERE jd.key = 'extract-and-create' AND it.key = 'transcript';

INSERT INTO job_definition_inputs (definition_id, input_type_id, required, description)
SELECT jd.id, it.id, true, 'Prompt for summarizing individual chunks'
FROM job_definitions jd, input_types it
WHERE jd.key = 'extract-and-create' AND it.key = 'chunk_prompt';


-- Memory Enrichment: analyze a memory and suggest improvements
INSERT INTO job_definitions (key, name, description, is_system) VALUES
  ('memory-enrichment', 'Memory Enrichment', 'Analyze a memory and suggest tags, relations, and an improved title', false);

INSERT INTO job_definition_steps (definition_id, step_index, key, name, step_type, input_source, input_config, timeout_ms)
SELECT jd.id, 0, 'analyze', 'Analyze', 'prompt', 'job_input', '{"input_type": "prompt"}'::jsonb, 120000
FROM job_definitions jd WHERE jd.key = 'memory-enrichment';

INSERT INTO job_definition_steps (definition_id, step_index, key, name, step_type, input_source, input_config, timeout_ms)
SELECT jd.id, 1, 'suggest', 'Suggest Improvements', 'prompt', 'template',
  '{"template": "Based on the analysis below, suggest specific improvements for this memory including:\n- Better title\n- Relevant tags\n- Relations to other memories\n- Content improvements\n\n## Original Memory\n\n{{job_input.prompt}}\n\n## Analysis\n\n{{step.analyze}}"}'::jsonb,
  120000
FROM job_definitions jd WHERE jd.key = 'memory-enrichment';

INSERT INTO job_definition_inputs (definition_id, input_type_id, required, description)
SELECT jd.id, it.id, true, 'Memory content to analyze'
FROM job_definitions jd, input_types it
WHERE jd.key = 'memory-enrichment' AND it.key = 'prompt';

-- DOWN

DELETE FROM job_definitions WHERE key IN (
  'chained-refinement', 'multi-agent-comparison', 'extract-and-create', 'memory-enrichment'
);
