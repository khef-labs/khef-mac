-- UP
CREATE TABLE assistant_memory_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_id UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  project_dir VARCHAR(500) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  file_path TEXT,
  current_version INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(assistant_id, project_dir, filename)
);

CREATE TABLE assistant_memory_file_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_file_id UUID NOT NULL REFERENCES assistant_memory_files(id) ON DELETE CASCADE,
  version INT NOT NULL,
  content TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  size INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(memory_file_id, version)
);

CREATE INDEX idx_amf_assistant ON assistant_memory_files(assistant_id);
CREATE INDEX idx_amf_project ON assistant_memory_files(project_id);
CREATE INDEX idx_amf_project_dir ON assistant_memory_files(project_dir);
CREATE INDEX idx_amfv_file ON assistant_memory_file_versions(memory_file_id);
CREATE INDEX idx_amfv_hash ON assistant_memory_file_versions(file_hash);

-- DOWN
DROP TABLE IF EXISTS assistant_memory_file_versions;
DROP TABLE IF EXISTS assistant_memory_files;
