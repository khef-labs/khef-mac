-- Migration: Add Single Prompt Handle To Session Summary
-- Created: 2026-02-12T19:11:18.907Z

-- UP

UPDATE kdag.job_definition_steps
SET config = config || '{"single_prompt_handle": "summarize-session-single"}'::jsonb
WHERE definition_id = (SELECT id FROM kdag.job_definitions WHERE key = 'session-summary')
  AND key = 'summarize';

-- DOWN

UPDATE kdag.job_definition_steps
SET config = config - 'single_prompt_handle'
WHERE definition_id = (SELECT id FROM kdag.job_definitions WHERE key = 'session-summary')
  AND key = 'summarize';
