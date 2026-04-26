-- Create samples project for example memories
INSERT INTO projects (id, handle, name, display_name, description)
VALUES (
  '019b0000-0000-7000-8000-000000000002',
  'samples',
  'Sample Memories',
  'Sample Memories',
  'Example memories demonstrating different memory types, diagrams, and markdown formatting.'
)
ON CONFLICT (handle) DO UPDATE SET
  name = EXCLUDED.name,
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description;
