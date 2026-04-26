-- Migration: Add allow_insecure_tls flag to kapi.collections
-- Created: 2026-04-20T12:38:14.000Z
--
-- Stores the "accept self-signed certs" preference per collection so it
-- travels with the collection (across devices, across sessions) instead
-- of living only in the UI's localStorage. Dev collections can enable it
-- while prod collections stay strict.

-- UP

ALTER TABLE kapi.collections
  ADD COLUMN allow_insecure_tls BOOLEAN NOT NULL DEFAULT FALSE;

-- DOWN

ALTER TABLE kapi.collections
  DROP COLUMN allow_insecure_tls;
