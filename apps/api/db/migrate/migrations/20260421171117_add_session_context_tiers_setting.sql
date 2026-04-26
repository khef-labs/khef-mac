-- Migration: Add configurable session context alert tiers
-- JSON array of { threshold (0..1), severity (info|warning|error) } entries.
-- Watcher raises a notification at the highest tier the session currently exceeds.

-- UP

INSERT INTO settings (key, value, description, value_type)
VALUES
  ('session.context.warn.tiers',
   '[{"threshold":0.5,"severity":"info"},{"threshold":0.75,"severity":"warning"},{"threshold":0.9,"severity":"error"}]',
   'Tiers (JSON array) for session context usage alerts. Each item: { threshold: 0..1, severity: info|warning|error }.',
   'json')
ON CONFLICT (key) DO NOTHING;

-- DOWN

DELETE FROM settings WHERE key = 'session.context.warn.tiers';
