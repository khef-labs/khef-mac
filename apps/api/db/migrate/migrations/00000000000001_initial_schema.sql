-- Migration: Initial schema
-- Created: 2024-01-01T00:00:01.000Z

-- UP

-- khef database schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- UUIDv7 generation function (time-ordered for better index performance)
CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS uuid
AS $$
DECLARE
  unix_ts_ms bytea;
  uuid_bytes bytea;
BEGIN
  unix_ts_ms = substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);

  -- Generate random bytes and set version/variant bits
  uuid_bytes = uuid_send(gen_random_uuid());

  -- Overlay timestamp into first 6 bytes
  uuid_bytes = set_byte(uuid_bytes, 0, get_byte(unix_ts_ms, 0));
  uuid_bytes = set_byte(uuid_bytes, 1, get_byte(unix_ts_ms, 1));
  uuid_bytes = set_byte(uuid_bytes, 2, get_byte(unix_ts_ms, 2));
  uuid_bytes = set_byte(uuid_bytes, 3, get_byte(unix_ts_ms, 3));
  uuid_bytes = set_byte(uuid_bytes, 4, get_byte(unix_ts_ms, 4));
  uuid_bytes = set_byte(uuid_bytes, 5, get_byte(unix_ts_ms, 5));

  -- Set version to 7 (0111 in bits 48-51)
  uuid_bytes = set_byte(uuid_bytes, 6, (b'0111' || substring(get_byte(uuid_bytes, 6)::bit(8)::text, 5, 4))::bit(8)::int);

  -- Set variant to 10 (bits 64-65)
  uuid_bytes = set_byte(uuid_bytes, 8, (b'10' || substring(get_byte(uuid_bytes, 8)::bit(8)::text, 3, 6))::bit(8)::int);

  RETURN encode(uuid_bytes, 'hex')::uuid;
END
$$ LANGUAGE plpgsql VOLATILE;

-- Memory relation type enum
DO $$ BEGIN
  CREATE TYPE relation_type AS ENUM (
    'relates_to',
    'contradicts',
    'supports',
    'depends_on',
    'follows_from',
    'references'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  name VARCHAR(255) NOT NULL,
  handle VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(255) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT handle_format CHECK (handle ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

-- Memory types table
CREATE TABLE IF NOT EXISTS memory_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  name VARCHAR(50) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Memory type statuses table (defines valid status values for each memory type)
CREATE TABLE IF NOT EXISTS memory_type_statuses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  memory_type_id UUID NOT NULL REFERENCES memory_types(id) ON DELETE CASCADE,
  status_value VARCHAR(50) NOT NULL,
  display_name VARCHAR(100),
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (memory_type_id, status_value)
);

-- Memories table
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  memory_type_id UUID NOT NULL REFERENCES memory_types(id),
  status_id UUID NOT NULL REFERENCES memory_type_statuses(id),
  status_updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

-- Memory chunks table
CREATE TABLE IF NOT EXISTS memory_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE(memory_id, chunk_index)
);

-- Tags table
CREATE TABLE IF NOT EXISTS tags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  name VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Memory-Tags join table
CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, tag_id)
);

-- Memory relations table (directed edges)
CREATE TABLE IF NOT EXISTS memory_relations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  source_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation_type relation_type NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_memory_id, target_memory_id, relation_type)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_memory_type_id ON memories(memory_type_id);
CREATE INDEX IF NOT EXISTS idx_memories_status_id ON memories(status_id);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_memory_id ON memory_chunks(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_tags_memory_id ON memory_tags(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_tags_tag_id ON memory_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_memory_relations_source ON memory_relations(source_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_relations_target ON memory_relations(target_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_relations_type ON memory_relations(relation_type);
CREATE INDEX IF NOT EXISTS idx_memory_type_statuses_memory_type_id ON memory_type_statuses(memory_type_id);

-- Full-text search indexes
CREATE INDEX IF NOT EXISTS idx_memories_content_tsv ON memories USING GIN(content_tsv);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_content_tsv ON memory_chunks USING GIN(content_tsv);

-- Function to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
DROP TRIGGER IF EXISTS update_projects_updated_at ON projects;
CREATE TRIGGER update_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_memories_updated_at ON memories;
CREATE TRIGGER update_memories_updated_at
  BEFORE UPDATE ON memories
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Function to validate same-project relations
CREATE OR REPLACE FUNCTION validate_same_project_relation()
RETURNS TRIGGER AS $$
DECLARE
  source_project UUID;
  target_project UUID;
BEGIN
  SELECT project_id INTO source_project FROM memories WHERE id = NEW.source_memory_id;
  SELECT project_id INTO target_project FROM memories WHERE id = NEW.target_memory_id;

  IF source_project != target_project THEN
    RAISE EXCEPTION 'Cannot create relation between memories from different projects';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to enforce same-project constraint
DROP TRIGGER IF EXISTS enforce_same_project_relation ON memory_relations;
CREATE TRIGGER enforce_same_project_relation
  BEFORE INSERT OR UPDATE ON memory_relations
  FOR EACH ROW
  EXECUTE FUNCTION validate_same_project_relation();

-- Function to validate memory status matches memory type
CREATE OR REPLACE FUNCTION validate_memory_status_matches_type()
RETURNS TRIGGER AS $$
BEGIN
  -- Validate status matches memory type
  IF NOT EXISTS (
    SELECT 1 FROM memory_type_statuses mts
    WHERE mts.id = NEW.status_id
      AND mts.memory_type_id = NEW.memory_type_id
  ) THEN
    RAISE EXCEPTION 'Status does not match memory type';
  END IF;

  -- Update status_updated_at when status changes
  IF (TG_OP = 'UPDATE' AND NEW.status_id IS DISTINCT FROM OLD.status_id) OR
     TG_OP = 'INSERT' THEN
    NEW.status_updated_at = NOW();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to validate memory status matches type
DROP TRIGGER IF EXISTS validate_memory_status_type ON memories;
CREATE TRIGGER validate_memory_status_type
  BEFORE INSERT OR UPDATE ON memories
  FOR EACH ROW
  EXECUTE FUNCTION validate_memory_status_matches_type();

-- Seed memory types
INSERT INTO memory_types (name, description) VALUES
  ('user-note', 'Notes created by users for personal or team reference'),
  ('agent-note', 'Notes generated by AI agents during interactions or tasks'),
  ('project-note', 'Notes specific to a project, providing context or details'),
  ('user-todo', 'Tasks or to-dos created by users'),
  ('agent-todo', 'Tasks or to-dos generated by AI agents'),
  ('decision', 'Architectural decisions, technical choices, and their rationale'),
  ('command', 'Commands to use when interacting with systems or tools, e.g. CLI commands'),
  ('context', 'Background information explaining why things are the way they are'),
  ('api', 'API documentation, endpoint descriptions, and usage examples'),
  ('pattern', 'Recurring code patterns, conventions, and best practices'),
  ('reference', 'External references, links, and documentation pointers'),
  ('agent-rule', 'Behavioral guidelines, coding standards, commit rules, etc.')
ON CONFLICT (name) DO NOTHING;

-- Seed default status values for each memory type
INSERT INTO memory_type_statuses (memory_type_id, status_value, display_name, description, sort_order)
SELECT mt.id, v.status_value, v.display_name, v.description, v.sort_order
FROM memory_types mt
CROSS JOIN (VALUES
  -- User Todo Statuses
  ('user-todo', 'open', 'To Do', 'Ready to work on', 0),
  ('user-todo', 'in_progress', 'In Progress', 'Currently being worked on', 1),
  ('user-todo', 'blocked', 'Blocked', 'Cannot proceed until unblocked', 2),
  ('user-todo', 'done', 'Done', 'Completed', 3),
  ('user-todo', 'canceled', 'Canceled', 'Will not be done', 4),

  -- Agent Todo Statuses
  ('agent-todo', 'open', 'To Do', 'Ready to work on', 0),
  ('agent-todo', 'in_progress', 'In Progress', 'Currently being worked on', 1),
  ('agent-todo', 'blocked', 'Blocked', 'Cannot proceed until unblocked', 2),
  ('agent-todo', 'done', 'Done', 'Completed', 3),
  ('agent-todo', 'canceled', 'Canceled', 'Will not be done', 4),

  -- Agent Note Statuses
  ('agent-note', 'transient', 'Transient Note', 'Short-lived note for temporary use', 0),
  ('agent-note', 'persistent', 'Persistent Note', 'Long-term note for ongoing reference', 1),

  -- Project Note Statuses
  ('project-note', 'transient', 'Transient Note', 'Short-term project note', 0),
  ('project-note', 'persistent', 'Persistent Note', 'Long-term project note', 1),

  -- User Note Statuses
  ('user-note', 'transient', 'Transient Note', 'Short-term note for quick reference', 0),
  ('user-note', 'persistent', 'Persistent Note', 'Long-term note for ongoing reference', 1),

  -- Command Statuses
  ('command', 'unverified', 'Unverified', 'Command not yet tested', 0),
  ('command', 'verified', 'Verified', 'Command tested and confirmed working', 1),
  ('command', 'deprecated', 'Deprecated', 'Command is outdated and should not be used', 2),

  -- Decision Statuses
  ('decision', 'proposed', 'Proposed', 'Decision proposed for consideration', 0),
  ('decision', 'accepted', 'Accepted', 'Decision accepted and active', 1),
  ('decision', 'rejected', 'Rejected', 'Decision rejected', 2),
  ('decision', 'superseded', 'Superseded', 'Replaced by newer decision', 3),

  -- Context Statuses
  ('context', 'current', 'Current', 'Currently relevant', 0),
  ('context', 'outdated', 'Outdated', 'No longer current', 1),
  ('context', 'updated', 'Updated', 'Recently updated', 2),

  -- Pattern Statuses
  ('pattern', 'proposed', 'Proposed', 'Pattern proposed for adoption', 0),
  ('pattern', 'active', 'Active', 'Actively used pattern', 1),
  ('pattern', 'deprecated', 'Deprecated', 'No longer recommended', 2),

  -- API Statuses
  ('api', 'draft', 'Draft', 'API in development', 0),
  ('api', 'stable', 'Stable', 'Stable and recommended', 1),
  ('api', 'deprecated', 'Deprecated', 'Marked for removal', 2),

  -- Reference Statuses
  ('reference', 'active', 'Active', 'Link is active and valid', 0),
  ('reference', 'outdated', 'Outdated', 'Content is outdated', 1),
  ('reference', 'broken', 'Broken', 'Link is broken', 2),

  -- Agent Rule Statuses
  ('agent-rule', 'active', 'Active', 'Rule is active', 0),
  ('agent-rule', 'deprecated', 'Deprecated', 'Rule no longer applies', 1)
) AS v(memory_type_name, status_value, display_name, description, sort_order)
WHERE mt.name = v.memory_type_name
ON CONFLICT (memory_type_id, status_value) DO NOTHING;


-- DOWN

DROP TRIGGER IF EXISTS validate_memory_status_type ON memories;
DROP TRIGGER IF EXISTS enforce_same_project_relation ON memory_relations;
DROP TRIGGER IF EXISTS update_memories_updated_at ON memories;
DROP TRIGGER IF EXISTS update_projects_updated_at ON projects;

DROP FUNCTION IF EXISTS validate_memory_status_matches_type() CASCADE;
DROP FUNCTION IF EXISTS validate_same_project_relation() CASCADE;
DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;

DROP INDEX IF EXISTS idx_memory_chunks_content_tsv;
DROP INDEX IF EXISTS idx_memories_content_tsv;
DROP INDEX IF EXISTS idx_memory_type_statuses_memory_type_id;
DROP INDEX IF EXISTS idx_memory_relations_type;
DROP INDEX IF EXISTS idx_memory_relations_target;
DROP INDEX IF EXISTS idx_memory_relations_source;
DROP INDEX IF EXISTS idx_memory_tags_tag_id;
DROP INDEX IF EXISTS idx_memory_tags_memory_id;
DROP INDEX IF EXISTS idx_memory_chunks_memory_id;
DROP INDEX IF EXISTS idx_memories_created_at;
DROP INDEX IF EXISTS idx_memories_status_id;
DROP INDEX IF EXISTS idx_memories_memory_type_id;
DROP INDEX IF EXISTS idx_memories_project_id;

DROP TABLE IF EXISTS memory_relations CASCADE;
DROP TABLE IF EXISTS memory_tags CASCADE;
DROP TABLE IF EXISTS tags CASCADE;
DROP TABLE IF EXISTS memory_chunks CASCADE;
DROP TABLE IF EXISTS memories CASCADE;
DROP TABLE IF EXISTS memory_type_statuses CASCADE;
DROP TABLE IF EXISTS memory_types CASCADE;
DROP TABLE IF EXISTS projects CASCADE;

DROP TYPE IF EXISTS relation_type CASCADE;

DROP FUNCTION IF EXISTS uuid_generate_v7() CASCADE;

DROP EXTENSION IF EXISTS "uuid-ossp" CASCADE;
