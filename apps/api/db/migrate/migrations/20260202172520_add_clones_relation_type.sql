-- Migration: Add 'clones' relation type
-- Used when creating an editable copy of a synced external memory (e.g., Google Doc)

-- UP
INSERT INTO relation_types (value, forward_label, inverse_value, inverse_label) VALUES
  ('clones', 'Clones', 'is_cloned_by', 'Cloned By')
ON CONFLICT (value) DO NOTHING;

-- DOWN
DELETE FROM relation_types WHERE value = 'clones';
