-- Migration: Add session context watcher toggle
-- Enables/disables the background watcher that raises notifications when
-- active sessions cross 50% / 75% / 90% of their model's context window.

-- UP

INSERT INTO settings (key, value, description, value_type)
VALUES
  ('session.context.watch.enabled', 'true', 'Enable session context usage notifications (50%/75%/90%)', 'boolean')
ON CONFLICT (key) DO NOTHING;

-- DOWN

DELETE FROM settings WHERE key = 'session.context.watch.enabled';
