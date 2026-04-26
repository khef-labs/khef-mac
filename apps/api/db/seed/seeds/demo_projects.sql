-- Create khef project for project-specific memories (rules, knowledge, todos)
INSERT INTO projects (id, handle, name, display_name, description)
VALUES (
  '019b0000-0000-7000-8000-000000000003',
  'khef',
  'khef',
  'Khef',
  'Project memory API with PostgreSQL backend for tracking development decisions, context, and knowledge.'
)
ON CONFLICT (handle) DO UPDATE SET
  name = EXCLUDED.name,
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description;

-- Create khef-demo project for walkthrough/demo slide content
INSERT INTO projects (id, handle, name, display_name, description)
VALUES (
  '019b0000-0000-7000-8000-000000000004',
  'khef-demo',
  'khef-demo',
  'Khef Demo',
  'Demo slide content and sample data for khef walkthroughs and presentations.'
)
ON CONFLICT (handle) DO UPDATE SET
  name = EXCLUDED.name,
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description;
