-- Migration: Align dbx.saved_queries.is_readonly with built-in status
-- Created: 2026-05-01
--
-- Conceptually a saved query is either built-in (seed-owned, read-only,
-- edit-locked) or user-authored (writable, editable). Backfill the existing
-- is_readonly flag so it strictly matches `owner_session_id IS NULL` —
-- every previously user-created query that defaulted to is_readonly=true
-- becomes writable.

-- UP

UPDATE dbx.saved_queries
SET is_readonly = (owner_session_id IS NULL);

-- DOWN

-- No reverse — the previous value was an arbitrary user choice; we don't
-- track its history. The down path leaves the aligned state in place.
