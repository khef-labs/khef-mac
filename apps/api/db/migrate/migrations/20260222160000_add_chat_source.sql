-- Migration: Add source and caller_handle columns to assistant_chats
-- Created: 2026-02-22T16:00:00Z

-- UP
ALTER TABLE assistant_chats ADD COLUMN source VARCHAR(20) DEFAULT 'api';
ALTER TABLE assistant_chats ADD COLUMN caller_handle VARCHAR(100);

-- DOWN
ALTER TABLE assistant_chats DROP COLUMN IF EXISTS caller_handle;
ALTER TABLE assistant_chats DROP COLUMN IF EXISTS source;
