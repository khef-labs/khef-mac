-- Migration: Create assistant_chats and assistant_chat_messages tables
-- Created: 2026-02-13T14:21:01Z

-- UP

CREATE TABLE assistant_chats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  assistant_handle VARCHAR(50) NOT NULL,
  title VARCHAR(200),
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE assistant_chat_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  chat_id UUID NOT NULL REFERENCES assistant_chats(id) ON DELETE CASCADE,
  prompt_text TEXT NOT NULL,
  response TEXT,
  model VARCHAR(100) NOT NULL,
  input_tokens INT,
  output_tokens INT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_assistant_chats_handle ON assistant_chats(assistant_handle);
CREATE INDEX idx_assistant_chats_project ON assistant_chats(project_id);
CREATE INDEX idx_assistant_chats_updated ON assistant_chats(updated_at DESC);
CREATE INDEX idx_assistant_chat_messages_chat ON assistant_chat_messages(chat_id);
CREATE INDEX idx_assistant_chat_messages_created ON assistant_chat_messages(created_at);

-- Auto-update updated_at on assistant_chats
CREATE TRIGGER update_assistant_chats_updated_at
  BEFORE UPDATE ON assistant_chats
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- DOWN

DROP TRIGGER IF EXISTS update_assistant_chats_updated_at ON assistant_chats;
DROP TABLE IF EXISTS assistant_chat_messages;
DROP TABLE IF EXISTS assistant_chats;
