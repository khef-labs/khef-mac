-- Migration: Make tracked_files content-addressable
-- Different content versions of the same file can coexist.
-- Same content at the same path is always a single row (idempotent).

-- UP

ALTER TABLE kvec.tracked_files
  DROP CONSTRAINT IF EXISTS tracked_files_collection_repo_filepath_uk;

ALTER TABLE kvec.tracked_files
  ADD CONSTRAINT tracked_files_collection_repo_filepath_hash_uk
  UNIQUE NULLS NOT DISTINCT (collection_id, repo_id, file_path, content_hash);

-- DOWN

ALTER TABLE kvec.tracked_files
  DROP CONSTRAINT IF EXISTS tracked_files_collection_repo_filepath_hash_uk;

ALTER TABLE kvec.tracked_files
  ADD CONSTRAINT tracked_files_collection_repo_filepath_uk
  UNIQUE NULLS NOT DISTINCT (collection_id, repo_id, file_path);
