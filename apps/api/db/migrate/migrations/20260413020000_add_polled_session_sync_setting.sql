-- Migration: Add polled session sync interval setting
-- Created: 2026-04-13T02:00:00.000Z
--
-- The push-based watcher (sessions.watcherActiveWindowDays) covers real-time
-- updates. The polled reconciliation pass now runs on its own cadence to catch
-- anything the watcher missed (stale files, watcher downtime, etc.).

-- UP
INSERT INTO settings (key, value, description, value_type) VALUES
  ('sessions.polledSyncIntervalMinutes', '60', 'How often the polled session reconciliation pass runs, in minutes. The push-based watcher covers real-time updates; this pass catches anything it missed. Set higher (e.g. 1440 for nightly) once the watcher has proven reliable.', 'number')
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key = 'sessions.polledSyncIntervalMinutes';
