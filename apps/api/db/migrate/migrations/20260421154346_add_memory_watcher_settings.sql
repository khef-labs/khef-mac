-- Migration: Add memory watcher settings
-- Thresholds and toggle for the background memory watcher that raises
-- notifications when tracked apps exceed RSS limits.

-- UP

INSERT INTO settings (key, value, description, value_type)
VALUES
  ('memory.watch.enabled', 'true', 'Enable the background memory watcher', 'boolean'),
  ('memory.iterm.warn_bytes', '21474836480', 'RSS threshold (bytes) at which an iTerm memory warning is raised (default 20 GB)', 'number')
ON CONFLICT (key) DO NOTHING;

-- DOWN

DELETE FROM settings WHERE key IN ('memory.watch.enabled', 'memory.iterm.warn_bytes');
