-- Migration: Add session_id to assistant_chats for persistent Claude sessions
-- Created: 2026-02-16T21:43:41Z

-- UP
ALTER TABLE assistant_chats ADD COLUMN session_id UUID;

-- DOWN
ALTER TABLE assistant_chats DROP COLUMN session_id;
