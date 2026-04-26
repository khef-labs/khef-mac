-- Migration: Create session teams tables
-- Created: 2026-04-09T21:15:06Z

-- UP
CREATE TABLE session_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE session_team_members (
  team_id UUID NOT NULL REFERENCES session_teams(id) ON DELETE CASCADE,
  session_id VARCHAR(100) NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, session_id)
);

CREATE INDEX idx_session_team_members_session ON session_team_members(session_id);
CREATE INDEX idx_session_teams_project ON session_teams(project_id);

CREATE TRIGGER set_session_teams_updated_at
  BEFORE UPDATE ON session_teams
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- DOWN
DROP TRIGGER IF EXISTS set_session_teams_updated_at ON session_teams;
DROP TABLE IF EXISTS session_team_members;
DROP TABLE IF EXISTS session_teams;
