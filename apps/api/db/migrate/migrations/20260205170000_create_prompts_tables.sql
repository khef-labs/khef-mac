-- Create prompts tables for unified prompt management
-- Supports universal prompts and assistant-specific prompts via join table

-- Core prompts table
CREATE TABLE prompts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  handle VARCHAR(100) NOT NULL UNIQUE,
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Join table for assistant-specific prompts
CREATE TABLE assistant_prompts (
  prompt_id UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  assistant_id UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  prompt_type VARCHAR(50) NOT NULL,  -- 'agent', 'command', 'prompt'
  source_path TEXT,  -- e.g., ~/.claude/commands/foo.md
  file_hash VARCHAR(64),  -- for sync conflict detection
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (prompt_id, assistant_id)
);

-- Prompt version history
CREATE TABLE prompt_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  prompt_id UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  snapshot_number INT NOT NULL,
  content TEXT NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  source VARCHAR(50) NOT NULL,  -- 'manual', 'pre-sync', 'pre-publish'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(prompt_id, snapshot_number)
);

-- Indexes for common queries
CREATE INDEX idx_assistant_prompts_assistant ON assistant_prompts(assistant_id);
CREATE INDEX idx_assistant_prompts_type ON assistant_prompts(prompt_type);
CREATE INDEX idx_prompt_snapshots_prompt ON prompt_snapshots(prompt_id);

-- Trigger to update updated_at on prompts
CREATE TRIGGER update_prompts_updated_at
  BEFORE UPDATE ON prompts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Trigger to update updated_at on assistant_prompts
CREATE TRIGGER update_assistant_prompts_updated_at
  BEFORE UPDATE ON assistant_prompts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- DOWN
DROP TRIGGER IF EXISTS update_assistant_prompts_updated_at ON assistant_prompts;
DROP TRIGGER IF EXISTS update_prompts_updated_at ON prompts;
DROP INDEX IF EXISTS idx_prompt_snapshots_prompt;
DROP INDEX IF EXISTS idx_assistant_prompts_type;
DROP INDEX IF EXISTS idx_assistant_prompts_assistant;
DROP TABLE IF EXISTS prompt_snapshots;
DROP TABLE IF EXISTS assistant_prompts;
DROP TABLE IF EXISTS prompts;
