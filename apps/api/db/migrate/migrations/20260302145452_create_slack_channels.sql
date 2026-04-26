-- Migration: Create slack_channels table for tracking Slack channel exports
-- Created: 2026-03-02T14:54:52Z

-- UP
CREATE TABLE slack_channels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  channel_id VARCHAR(20) NOT NULL,
  workspace_id VARCHAR(20) NOT NULL,
  workspace_name VARCHAR(100),
  channel_name VARCHAR(200) NOT NULL,
  channel_type VARCHAR(20) DEFAULT 'dm',
  export_path TEXT,
  last_message_ts VARCHAR(20),
  last_exported_at TIMESTAMPTZ,
  message_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workspace_id, channel_id)
);

CREATE INDEX idx_slack_channels_workspace ON slack_channels(workspace_id);

-- DOWN
DROP TABLE IF EXISTS slack_channels;
