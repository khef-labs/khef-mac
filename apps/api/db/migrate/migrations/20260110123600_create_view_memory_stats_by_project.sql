-- Migration: Create view memory_stats_by_project
-- Created: 2026-01-10T12:36:00.000Z

-- UP

CREATE OR REPLACE VIEW memory_stats_by_project AS
WITH
  type_counts AS (
    SELECT m.project_id, mt.name AS type_name, COUNT(*) AS count
    FROM memories m
    JOIN memory_types mt ON mt.id = m.memory_type_id
    GROUP BY m.project_id, mt.name
  ),
  status_counts AS (
    SELECT m.project_id, mts.status_value, COUNT(*) AS count
    FROM memories m
    JOIN memory_type_statuses mts ON mts.id = m.status_id
    GROUP BY m.project_id, mts.status_value
  )
SELECT
  p.id AS project_id,
  p.handle AS project_handle,
  p.display_name AS project_name,
  (SELECT COUNT(*) FROM memories m WHERE m.project_id = p.id) AS total_memories,
  (SELECT MAX(m.created_at) FROM memories m WHERE m.project_id = p.id) AS last_created_at,
  (SELECT MAX(m.updated_at) FROM memories m WHERE m.project_id = p.id) AS last_updated_at,
  COALESCE((
    SELECT jsonb_object_agg(tc.type_name, tc.count)
    FROM type_counts tc
    WHERE tc.project_id = p.id
  ), '{}'::jsonb) AS by_type,
  COALESCE((
    SELECT jsonb_object_agg(sc.status_value, sc.count)
    FROM status_counts sc
    WHERE sc.project_id = p.id
  ), '{}'::jsonb) AS by_status,
  COALESCE((
    SELECT COUNT(DISTINCT t.name)
    FROM memories m
    JOIN memory_tags mtg ON mtg.memory_id = m.id
    JOIN tags t ON t.id = mtg.tag_id
    WHERE m.project_id = p.id
  ), 0) AS distinct_tags
FROM projects p;

-- DOWN

DROP VIEW IF EXISTS memory_stats_by_project;

