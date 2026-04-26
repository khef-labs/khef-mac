-- Migration: Add backlog and in_review statuses to ticket type
-- New order: backlog(0), blocked(1), open(2), in_progress(3), in_review(4), done(5), canceled(6)
-- Created: 2026-03-19T18:45:19.808Z

-- UP

-- Re-assign all existing sort_orders to final positions
UPDATE memory_type_statuses
SET sort_order = CASE status_value
  WHEN 'open' THEN 2
  WHEN 'in_progress' THEN 3
  WHEN 'blocked' THEN 1
  WHEN 'done' THEN 5
  WHEN 'canceled' THEN 6
END
WHERE memory_type_id = (SELECT id FROM memory_types WHERE name = 'ticket')
  AND status_value IN ('open', 'in_progress', 'blocked', 'done', 'canceled');

-- Insert backlog at sort_order 0
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, 'backlog', 'Backlog', 'Not yet prioritized', 0
FROM memory_types mt
WHERE mt.name = 'ticket'
  AND NOT EXISTS (
    SELECT 1 FROM memory_type_statuses mts
    WHERE mts.memory_type_id = mt.id AND mts.status_value = 'backlog'
  );

-- Insert in_review at sort_order 4
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, 'in_review', 'In Review', 'Work complete, awaiting review', 4
FROM memory_types mt
WHERE mt.name = 'ticket'
  AND NOT EXISTS (
    SELECT 1 FROM memory_type_statuses mts
    WHERE mts.memory_type_id = mt.id AND mts.status_value = 'in_review'
  );

-- DOWN

DELETE FROM memory_type_statuses
WHERE memory_type_id = (SELECT id FROM memory_types WHERE name = 'ticket')
  AND status_value IN ('backlog', 'in_review');

-- Restore original sort_order: open=0, in_progress=1, blocked=2, done=3, canceled=4
UPDATE memory_type_statuses
SET sort_order = CASE status_value
  WHEN 'open' THEN 0
  WHEN 'in_progress' THEN 1
  WHEN 'blocked' THEN 2
  WHEN 'done' THEN 3
  WHEN 'canceled' THEN 4
END
WHERE memory_type_id = (SELECT id FROM memory_types WHERE name = 'ticket')
  AND status_value IN ('open', 'in_progress', 'blocked', 'done', 'canceled');
