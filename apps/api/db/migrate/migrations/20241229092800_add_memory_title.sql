-- Migration: Add memory title
-- Created: 2024-12-29T09:28:00.000Z

-- UP

-- Create a function to generate a title from content
CREATE OR REPLACE FUNCTION generate_memory_title(content_text TEXT)
RETURNS VARCHAR(200)
AS $$
DECLARE
  cleaned_text TEXT;
  first_sentence TEXT;
  title TEXT;
BEGIN
  -- Remove markdown headers (## , ### , etc)
  cleaned_text := REGEXP_REPLACE(content_text, '^#{1,6}\s+', '', 'g');

  -- Remove markdown bold (**text**)
  cleaned_text := REGEXP_REPLACE(cleaned_text, '\*\*([^*]+)\*\*', '\1', 'g');

  -- Remove markdown links ([text](url))
  cleaned_text := REGEXP_REPLACE(cleaned_text, '\[([^\]]+)\]\([^\)]+\)', '\1', 'g');

  -- Remove markdown code blocks (```text```)
  cleaned_text := REGEXP_REPLACE(cleaned_text, '`{1,3}([^`]+)`{1,3}', '\1', 'g');

  -- Trim leading/trailing whitespace and collapse multiple spaces
  cleaned_text := REGEXP_REPLACE(TRIM(cleaned_text), '\s+', ' ', 'g');

  -- Extract first sentence (up to first . ? or ! followed by space or end)
  first_sentence := SUBSTRING(cleaned_text FROM '^([^.!?]+[.!?](?:\s|$))');

  IF first_sentence IS NOT NULL AND LENGTH(first_sentence) > 0 THEN
    title := TRIM(first_sentence);
  ELSE
    -- No sentence break found, take first ~180 chars
    title := SUBSTRING(cleaned_text FROM 1 FOR 180);
  END IF;

  -- If still too long, truncate at last word boundary before 197 chars (leaving room for "...")
  IF LENGTH(title) > 197 THEN
    title := SUBSTRING(title FROM 1 FOR 197);
    -- Find last space
    title := SUBSTRING(title FROM 1 FOR LENGTH(title) - POSITION(' ' IN REVERSE(title)));
    title := title || '...';
  END IF;

  -- Ensure we don't exceed 200 chars
  title := SUBSTRING(title FROM 1 FOR 200);

  -- Trim any trailing periods or whitespace
  title := REGEXP_REPLACE(title, '[.\s]+$', '');

  -- If title is empty, use a default
  IF title IS NULL OR LENGTH(title) = 0 THEN
    title := 'Untitled';
  END IF;

  RETURN title;
END
$$ LANGUAGE plpgsql IMMUTABLE;

-- Add title column (nullable initially to allow updating existing rows)
ALTER TABLE memories ADD COLUMN IF NOT EXISTS title VARCHAR(200);

-- Generate titles for existing memories and ensure uniqueness within each project
DO $$
DECLARE
  mem RECORD;
  base_title VARCHAR(200);
  final_title VARCHAR(200);
  title_counter INTEGER;
  title_exists BOOLEAN;
BEGIN
  FOR mem IN
    SELECT id, project_id, content
    FROM memories
    WHERE title IS NULL
    ORDER BY created_at ASC  -- Process oldest first for consistency
  LOOP
    -- Generate base title from content
    base_title := generate_memory_title(mem.content);
    final_title := base_title;
    title_counter := 1;

    -- Check if title exists in this project, append number if needed
    LOOP
      SELECT EXISTS(
        SELECT 1
        FROM memories
        WHERE project_id = mem.project_id
          AND title = final_title
          AND id != mem.id
      ) INTO title_exists;

      EXIT WHEN NOT title_exists;

      title_counter := title_counter + 1;

      -- Append counter, ensuring we don't exceed 200 chars
      IF LENGTH(base_title) + LENGTH(' ' || title_counter::TEXT) > 200 THEN
        final_title := SUBSTRING(base_title FROM 1 FOR (200 - LENGTH(' ' || title_counter::TEXT))) || ' ' || title_counter::TEXT;
      ELSE
        final_title := base_title || ' ' || title_counter::TEXT;
      END IF;
    END LOOP;

    -- Update the memory with the unique title
    UPDATE memories
    SET title = final_title
    WHERE id = mem.id;
  END LOOP;
END
$$;

-- Make title column NOT NULL after populating
ALTER TABLE memories ALTER COLUMN title SET NOT NULL;

-- Add UNIQUE constraint on (project_id, title)
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_project_title_key;
ALTER TABLE memories ADD CONSTRAINT memories_project_title_key UNIQUE (project_id, title);

-- Drop the helper function (no longer needed after migration)
DROP FUNCTION IF EXISTS generate_memory_title(TEXT);


-- DOWN

-- Drop the unique constraint
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_project_title_key;

-- Drop the title column
ALTER TABLE memories DROP COLUMN IF EXISTS title;

-- Recreate the helper function if needed (in case someone rolls back mid-migration)
DROP FUNCTION IF EXISTS generate_memory_title(TEXT) CASCADE;
