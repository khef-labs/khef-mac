-- Migration: Add layout.boardMaxWidth setting
-- Controls the max width of the board view layout separately from page width.

-- UP

INSERT INTO settings (key, value, description, value_type)
VALUES ('layout.boardMaxWidth', '1600', 'Max width for board view layout (pixels)', 'number')
ON CONFLICT (key) DO NOTHING;

-- DOWN

DELETE FROM settings WHERE key = 'layout.boardMaxWidth';
