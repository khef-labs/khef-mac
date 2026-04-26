-- Migration: Add grounding and thinking columns to assistant_chat_messages
-- Created: 2026-02-23T22:02:48Z

-- UP

ALTER TABLE assistant_chat_messages ADD COLUMN grounding JSONB;
ALTER TABLE assistant_chat_messages ADD COLUMN thinking JSONB;

-- DOWN

ALTER TABLE assistant_chat_messages DROP COLUMN IF EXISTS thinking;
ALTER TABLE assistant_chat_messages DROP COLUMN IF EXISTS grounding;
