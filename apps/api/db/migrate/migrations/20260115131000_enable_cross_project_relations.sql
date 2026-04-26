-- Migration: Enable cross-project relations by relaxing same-project constraint

-- UP: Allow relations across projects (no-op validator)
CREATE OR REPLACE FUNCTION validate_same_project_relation()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow any relation regardless of project; keep trigger to preserve hook point
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- DOWN
CREATE OR REPLACE FUNCTION validate_same_project_relation()
RETURNS TRIGGER AS $$
DECLARE
  source_project UUID;
  target_project UUID;
  user_project_id UUID;
BEGIN
  SELECT project_id INTO source_project FROM memories WHERE id = NEW.source_memory_id;
  SELECT project_id INTO target_project FROM memories WHERE id = NEW.target_memory_id;

  SELECT id INTO user_project_id FROM projects WHERE handle = 'user';

  IF source_project != target_project
     AND (user_project_id IS NULL OR (source_project != user_project_id AND target_project != user_project_id)) THEN
    RAISE EXCEPTION 'Cannot create relation between memories from different projects (cross-project relations only allowed with the "user" project)';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
