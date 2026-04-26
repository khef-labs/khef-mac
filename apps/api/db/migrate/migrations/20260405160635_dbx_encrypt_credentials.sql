-- Migration: Change dbx.connections credentials from JSONB to TEXT for encrypted storage
-- Created: 2026-04-05T16:06:35Z

-- UP

ALTER TABLE dbx.connections ALTER COLUMN credentials TYPE TEXT USING credentials::text;

-- DOWN

ALTER TABLE dbx.connections ALTER COLUMN credentials TYPE JSONB USING
  CASE WHEN credentials IS NULL THEN NULL
       ELSE credentials::jsonb
  END;
