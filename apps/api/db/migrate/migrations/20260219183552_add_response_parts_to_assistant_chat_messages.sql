-- Migration: Add response_parts JSONB column to assistant_chat_messages
-- Created: 2026-02-19T18:35:52Z

-- UP
ALTER TABLE assistant_chat_messages ADD COLUMN response_parts jsonb;

-- DOWN
ALTER TABLE assistant_chat_messages DROP COLUMN IF EXISTS response_parts;
