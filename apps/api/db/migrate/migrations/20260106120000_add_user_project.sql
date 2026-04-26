-- Migration: Add reserved "user" project for general/user memories
-- and allow cross-project relations when one memory is in the "user" project.

-- UP

-- Create reserved "user" project with well-known UUID
-- This project holds general/user memories not tied to a specific project.
INSERT INTO projects (id, name, handle, display_name, description)
VALUES (
  '00000000-0000-7000-8000-000000000001',
  'User',
  'user',
  'User',
  'Reserved project for general and user memories not tied to a specific project. Memories here can relate to memories in other projects.'
)
ON CONFLICT (handle) DO NOTHING;

-- Update trigger to allow cross-project relations when one memory is in "user" project
CREATE OR REPLACE FUNCTION validate_same_project_relation()
RETURNS TRIGGER AS $$
DECLARE
  source_project UUID;
  target_project UUID;
  user_project_id UUID;
BEGIN
  SELECT project_id INTO source_project FROM memories WHERE id = NEW.source_memory_id;
  SELECT project_id INTO target_project FROM memories WHERE id = NEW.target_memory_id;

  -- Get the reserved "user" project ID
  SELECT id INTO user_project_id FROM projects WHERE handle = 'user';

  -- Allow relation if:
  -- 1. Both memories are in the same project, OR
  -- 2. One of the memories is in the "user" project
  IF source_project != target_project
     AND (user_project_id IS NULL OR (source_project != user_project_id AND target_project != user_project_id)) THEN
    RAISE EXCEPTION 'Cannot create relation between memories from different projects (cross-project relations only allowed with the "user" project)';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- DOWN

-- Restore original strict same-project constraint
CREATE OR REPLACE FUNCTION validate_same_project_relation()
RETURNS TRIGGER AS $$
DECLARE
  source_project UUID;
  target_project UUID;
BEGIN
  SELECT project_id INTO source_project FROM memories WHERE id = NEW.source_memory_id;
  SELECT project_id INTO target_project FROM memories WHERE id = NEW.target_memory_id;

  IF source_project != target_project THEN
    RAISE EXCEPTION 'Cannot create relation between memories from different projects';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Note: Deleting the user project would cascade delete all user memories.
-- Only uncomment if truly reverting and you understand this will delete data.
-- DELETE FROM projects WHERE handle = 'user';
