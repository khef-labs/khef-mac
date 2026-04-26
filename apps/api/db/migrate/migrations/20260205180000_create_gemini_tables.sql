-- Migration: Create Gemini Tables
-- Created: 2026-02-05
-- Gemini conversation tracking with prompt template support

-- UP

-- Conversations container
CREATE TABLE gemini_conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  title VARCHAR(200),
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Message history (stateless - each row is a prompt/response pair)
CREATE TABLE gemini_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  conversation_id UUID NOT NULL REFERENCES gemini_conversations(id) ON DELETE CASCADE,
  prompt_id UUID REFERENCES prompts(id) ON DELETE SET NULL,  -- NULL for free-text
  prompt_text TEXT NOT NULL,  -- actual text sent to Gemini
  response TEXT,  -- NULL if error
  model VARCHAR(100) NOT NULL,
  input_tokens INT,
  output_tokens INT,
  error TEXT,  -- error message if call failed
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_gemini_conversations_project ON gemini_conversations(project_id);
CREATE INDEX idx_gemini_messages_conversation ON gemini_messages(conversation_id);
CREATE INDEX idx_gemini_messages_prompt ON gemini_messages(prompt_id);

-- Trigger to update updated_at on conversations
CREATE TRIGGER update_gemini_conversations_updated_at
  BEFORE UPDATE ON gemini_conversations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- DOWN
DROP TRIGGER IF EXISTS update_gemini_conversations_updated_at ON gemini_conversations;
DROP INDEX IF EXISTS idx_gemini_messages_prompt;
DROP INDEX IF EXISTS idx_gemini_messages_conversation;
DROP INDEX IF EXISTS idx_gemini_conversations_project;
DROP TABLE IF EXISTS gemini_messages;
DROP TABLE IF EXISTS gemini_conversations;
