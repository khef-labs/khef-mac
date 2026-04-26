-- Add built_in flag to memory_types and protect built-in types from modification

ALTER TABLE memory_types ADD COLUMN built_in BOOLEAN NOT NULL DEFAULT FALSE;

-- Mark existing types as built-in
UPDATE memory_types SET built_in = TRUE WHERE name IN (
  'user-note', 'assistant-note', 'project-note',
  'user-todo', 'assistant-todo',
  'decision',
  'knowledge', 'commands', 'context', 'pattern',
  'assistant-rule',
  'diagram',
  'api', 'reference'
);

-- Trigger to prevent modification of built-in types
CREATE OR REPLACE FUNCTION prevent_builtin_type_modification()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.built_in = TRUE THEN
    RAISE EXCEPTION 'Cannot delete built-in memory type: %', OLD.name;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.built_in = TRUE AND OLD.name != NEW.name THEN
    RAISE EXCEPTION 'Cannot rename built-in memory type: %', OLD.name;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_builtin_memory_types
BEFORE UPDATE OR DELETE ON memory_types
FOR EACH ROW EXECUTE FUNCTION prevent_builtin_type_modification();

-- DOWN
DROP TRIGGER IF EXISTS protect_builtin_memory_types ON memory_types;
DROP FUNCTION IF EXISTS prevent_builtin_type_modification();
ALTER TABLE memory_types DROP COLUMN IF EXISTS built_in;
