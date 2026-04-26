-- Migration: Add chat delegations table for explicit 3NF turn-to-child-chat associations
-- Created: 2026-02-21

-- UP

-- 1. Add status and updated_at to messages (for two-phase turn lifecycle)
ALTER TABLE assistant_chat_messages
  ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'completed',
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 2. Create delegation table
CREATE TABLE assistant_chat_delegations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  parent_turn_id UUID NOT NULL REFERENCES assistant_chat_messages(id) ON DELETE CASCADE,
  child_chat_id UUID NOT NULL REFERENCES assistant_chats(id) ON DELETE CASCADE,
  delegated_handle VARCHAR(50) NOT NULL,
  tool_call_id VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_chat_delegations_child ON assistant_chat_delegations(child_chat_id);
CREATE INDEX idx_chat_delegations_parent_turn ON assistant_chat_delegations(parent_turn_id);

-- 3. Clean slate: truncate existing chat data (ephemeral, no knowledge value)
TRUNCATE assistant_chat_messages CASCADE;
TRUNCATE assistant_chats CASCADE;

-- DOWN
DROP TABLE IF EXISTS assistant_chat_delegations;
ALTER TABLE assistant_chat_messages DROP COLUMN IF EXISTS status;
ALTER TABLE assistant_chat_messages DROP COLUMN IF EXISTS updated_at;
