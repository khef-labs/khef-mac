-- Migration: Add path column to files table
-- Store full filesystem path per file instead of computing from settings

-- Step 1: Add path column (nullable initially for existing rows)
ALTER TABLE files ADD COLUMN path TEXT;

-- Step 2: Populate path for existing files using current storage setting
-- Path format: {storagePath}/{project_handle}/{filename}
UPDATE files f
SET path = (
  SELECT CONCAT(s.value, '/', p.handle, '/', f.filename)
  FROM settings s, projects p
  WHERE s.key = 'files.storagePath'
  AND p.id = f.project_id
);

-- Step 3: Make path NOT NULL after population
ALTER TABLE files ALTER COLUMN path SET NOT NULL;

-- DOWN

ALTER TABLE files DROP COLUMN path;
