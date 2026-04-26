-- Seed default status values for each memory type
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, v.status_value, v.display_name, v.description, v.sort_order
FROM memory_types mt
CROSS JOIN (VALUES
  -- User Todo Statuses
  ('user-todo', 'open', 'To Do', 'Ready to work on', 0),
  ('user-todo', 'in_progress', 'In Progress', 'Currently being worked on', 1),
  ('user-todo', 'blocked', 'Blocked', 'Cannot proceed until unblocked', 2),
  ('user-todo', 'done', 'Done', 'Completed', 3),
  ('user-todo', 'canceled', 'Canceled', 'Will not be done', 4),

  -- Assistant Todo Statuses
  ('assistant-todo', 'open', 'To Do', 'Ready to work on', 0),
  ('assistant-todo', 'in_progress', 'In Progress', 'Currently being worked on', 1),
  ('assistant-todo', 'blocked', 'Blocked', 'Cannot proceed until unblocked', 2),
  ('assistant-todo', 'done', 'Done', 'Completed', 3),
  ('assistant-todo', 'canceled', 'Canceled', 'Will not be done', 4),

  -- Assistant Note Statuses
  ('assistant-note', 'transient', 'Transient Note', 'Short-lived note for temporary use', 0),
  ('assistant-note', 'persistent', 'Persistent Note', 'Long-term note for ongoing reference', 1),

  -- Project Note Statuses
  ('project-note', 'transient', 'Transient Note', 'Short-term project note', 0),
  ('project-note', 'persistent', 'Persistent Note', 'Long-term project note', 1),

  -- User Note Statuses
  ('user-note', 'transient', 'Transient Note', 'Short-term note for quick reference', 0),
  ('user-note', 'persistent', 'Persistent Note', 'Long-term note for ongoing reference', 1),

  -- Decision Statuses
  ('decision', 'proposed', 'Proposed', 'Decision proposed for consideration', 0),
  ('decision', 'accepted', 'Accepted', 'Decision accepted and active', 1),
  ('decision', 'rejected', 'Rejected', 'Decision rejected', 2),
  ('decision', 'superseded', 'Superseded', 'Replaced by newer decision', 3),

  -- API Statuses
  ('api', 'draft', 'Draft', 'API in development', 0),
  ('api', 'stable', 'Stable', 'Stable and recommended', 1),
  ('api', 'deprecated', 'Deprecated', 'Marked for removal', 2),

  -- Reference Statuses
  ('reference', 'active', 'Active', 'Link is active and valid', 0),
  ('reference', 'outdated', 'Outdated', 'Content is outdated', 1),
  ('reference', 'broken', 'Broken', 'Link is broken', 2),

  -- Agent Rule Statuses
  ('assistant-rule', 'active', 'Active', 'Rule is active', 0),
  ('assistant-rule', 'deprecated', 'Deprecated', 'Rule no longer applies', 1),
  ('assistant-rule', 'inactive', 'Inactive', 'Memory is inactive', 10),

  -- CSV Statuses
  ('csv', 'draft', 'Draft', 'Work in progress', 0),
  ('csv', 'published', 'Published', 'Finalized dataset', 1),
  ('csv', 'archived', 'Archived', 'No longer current', 2),

  -- Video Statuses
  ('video', 'unwatched', 'Unwatched', 'Not yet viewed', 0),
  ('video', 'watched', 'Watched', 'Already viewed', 1),

  -- Canvas parent type statuses (children inherit these)
  ('canvas', 'draft', 'Draft', 'Work in progress', 0),
  ('canvas', 'published', 'Published', 'Finalized and shareable', 1),
  ('canvas', 'archived', 'Archived', 'No longer current', 2),

  -- Knowledge parent type fallback statuses
  ('knowledge', 'current', 'Current', 'Currently relevant', 0),
  ('knowledge', 'deprecated', 'Deprecated', 'No longer recommended', 1),

  -- Commands (knowledge child) Statuses
  ('commands', 'unverified', 'Unverified', 'Command not yet tested', 0),
  ('commands', 'verified', 'Verified', 'Command tested and confirmed working', 1),
  ('commands', 'deprecated', 'Deprecated', 'Command is outdated and should not be used', 2),
  ('commands', 'inactive', 'Inactive', 'Memory is inactive', 10),

  -- Context (knowledge child) Statuses
  ('context', 'current', 'Current', 'Currently relevant', 0),
  ('context', 'outdated', 'Outdated', 'No longer current', 1),
  ('context', 'updated', 'Updated', 'Recently updated', 2),
  ('context', 'inactive', 'Inactive', 'Memory is inactive', 10),

  -- Pattern (knowledge child) Statuses
  ('pattern', 'proposed', 'Proposed', 'Pattern proposed for adoption', 0),
  ('pattern', 'active', 'Active', 'Actively used pattern', 1),
  ('pattern', 'deprecated', 'Deprecated', 'No longer recommended', 2),
  ('pattern', 'inactive', 'Inactive', 'Memory is inactive', 10)
) AS v(memory_type_name, status_value, display_name, description, sort_order)
WHERE mt.name = v.memory_type_name
ON CONFLICT (memory_type_id, status_value) DO NOTHING;
