-- Migration: Create view user_memories
-- Created: 2026-01-10T12:30:00.000Z

-- UP

CREATE OR REPLACE VIEW user_memories AS
SELECT
  m.id,
  m.handle,
  m.title,
  mt.name AS type_name,
  mts.status_value,
  m.created_at,
  m.updated_at,
  COALESCE(ARRAY_AGG(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
FROM memories m
JOIN projects p ON p.id = m.project_id
JOIN memory_types mt ON mt.id = m.memory_type_id
JOIN memory_type_statuses mts ON mts.id = m.status_id
LEFT JOIN memory_tags mtg ON mtg.memory_id = m.id
LEFT JOIN tags t ON t.id = mtg.tag_id
WHERE p.handle = 'user'
GROUP BY m.id, m.handle, m.title, mt.name, mts.status_value, m.created_at, m.updated_at;

-- DOWN

DROP VIEW IF EXISTS user_memories;

