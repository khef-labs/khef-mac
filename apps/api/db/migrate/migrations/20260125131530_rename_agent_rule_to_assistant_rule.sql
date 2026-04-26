-- Rename agent-rule to assistant-rule for naming consistency
-- Follows the agent-todo/agent-note → assistant-todo/assistant-note rename

UPDATE memory_types SET
  name = 'assistant-rule',
  description = 'Behavioral guidelines, coding standards, commit rules, etc.'
WHERE name = 'agent-rule';

-- DOWN

UPDATE memory_types SET
  name = 'agent-rule',
  description = 'Behavioral guidelines, coding standards, commit rules, etc.'
WHERE name = 'assistant-rule';
