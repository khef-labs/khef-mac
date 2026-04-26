-- Migration: Drop session_messages table (replaced by Redis live messages)
-- Created: 2026-03-08T15:59:06.396Z

-- UP

DROP TABLE IF EXISTS session_messages;

-- DOWN

CREATE TABLE session_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  from_session_id VARCHAR NOT NULL,
  to_session_id VARCHAR NOT NULL,
  reply_to UUID REFERENCES session_messages(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('pending', 'read', 'replied')),
  CHECK (from_session_id != to_session_id)
);

CREATE INDEX idx_session_messages_to_status ON session_messages(to_session_id, status);
CREATE INDEX idx_session_messages_from ON session_messages(from_session_id);
CREATE INDEX idx_session_messages_reply_to ON session_messages(reply_to);
CREATE INDEX idx_session_messages_created ON session_messages(created_at DESC);
