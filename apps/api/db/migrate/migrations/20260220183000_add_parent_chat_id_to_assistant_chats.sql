-- Migration: Add parent_chat_id to assistant_chats for delegated inline chat linking
-- Created: 2026-02-20T18:30:00Z

-- UP
ALTER TABLE assistant_chats
  ADD COLUMN parent_chat_id UUID REFERENCES assistant_chats(id) ON DELETE CASCADE;

CREATE INDEX idx_assistant_chats_parent ON assistant_chats (parent_chat_id);

-- DOWN
DROP INDEX IF EXISTS idx_assistant_chats_parent;
ALTER TABLE assistant_chats DROP COLUMN parent_chat_id;
