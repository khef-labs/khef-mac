-- Migration: Add session watcher settings (push-based session sync)
-- Created: 2026-04-13T00:15:00.000Z

-- UP
INSERT INTO settings (key, value, description, value_type) VALUES
  ('sessions.watcherActiveWindowDays', '7', 'Only watch session JSONL files with mtime within this many days. Lower values reduce file descriptor usage on machines with large session histories.', 'number')
ON CONFLICT (key) DO NOTHING;

-- DOWN
DELETE FROM settings WHERE key = 'sessions.watcherActiveWindowDays';
