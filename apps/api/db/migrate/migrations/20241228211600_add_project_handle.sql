-- Migration: Add project handle
-- Created: 2024-12-28T21:16:00.000Z

-- UP

-- Add columns (nullable initially to allow updating existing rows)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS handle VARCHAR(100);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);

-- Add CHECK constraint for handle format
ALTER TABLE projects DROP CONSTRAINT IF EXISTS handle_format;
ALTER TABLE projects ADD CONSTRAINT handle_format CHECK (handle ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');

-- Update existing projects to have handle and display_name
-- Generate handle from name using slugification logic
UPDATE projects
SET
  handle = LOWER(
    REGEXP_REPLACE(
      REGEXP_REPLACE(
        REGEXP_REPLACE(TRIM(name), '[\s_]+', '-', 'g'),  -- Replace spaces/underscores with hyphens
        '[^a-z0-9-]', '', 'g'                             -- Remove non-alphanumeric except hyphens
      ),
      '-+', '-', 'g'                                      -- Replace multiple hyphens with single
    )
  ),
  display_name = name
WHERE handle IS NULL OR display_name IS NULL;

-- Make columns NOT NULL after populating
ALTER TABLE projects ALTER COLUMN handle SET NOT NULL;
ALTER TABLE projects ALTER COLUMN display_name SET NOT NULL;

-- Add UNIQUE constraint
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_handle_key;
ALTER TABLE projects ADD CONSTRAINT projects_handle_key UNIQUE (handle);


-- DOWN

-- Drop the unique constraint
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_handle_key;

-- Drop the check constraint
ALTER TABLE projects DROP CONSTRAINT IF EXISTS handle_format;

-- Drop the columns
ALTER TABLE projects DROP COLUMN IF EXISTS handle;
ALTER TABLE projects DROP COLUMN IF EXISTS display_name;
