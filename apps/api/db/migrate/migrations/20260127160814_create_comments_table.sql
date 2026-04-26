-- Migration: Create Comments Table
-- Created: 2026-01-27T22:08:14.818Z

-- UP

CREATE TABLE comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (char_length(content) <= 5000),
  anchor_text VARCHAR(500),
  anchor_prefix VARCHAR(128),
  anchor_suffix VARCHAR(128),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'orphaned', 'resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_comments_memory_id ON comments(memory_id);
CREATE INDEX idx_comments_created_at ON comments(created_at);

CREATE TRIGGER update_comments_updated_at
  BEFORE UPDATE ON comments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- DOWN

DROP TABLE IF EXISTS comments;
