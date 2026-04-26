export type MemoryType = 'user-note' | 'assistant-note' | 'project-note' | 'user-todo' | 'assistant-todo' | 'decision' | 'command' | 'context' | 'api' | 'pattern' | 'reference' | 'assistant-rule' | 'diagram' | 'knowledge' | 'commands';
export type RelationType = 'relates_to' | 'contradicts' | 'supports' | 'depends_on' | 'follows_from' | 'references';

// Metadata entity types
export const ENTITY_TYPE = {
  MEMORY: 'memory',
  PROJECT: 'project',
} as const;
export type EntityType = (typeof ENTITY_TYPE)[keyof typeof ENTITY_TYPE];

// Comment entity types (for polymorphic comments)
export type CommentEntityType = 'memory' | 'plan' | 'diff';

export interface Project {
  id: string;
  name: string;
  handle: string;
  display_name: string;
  description?: string;
  path?: string;
  is_favorite: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryTypeRecord {
  id: string;
  name: MemoryType;
  description?: string;
  built_in: boolean;
  parent_id?: string;
  created_at: Date;
}

export interface MemoryTypeStatus {
  id: string;
  memory_type_id: string;
  status_value: string;
  display_name?: string;
  description?: string;
  sort_order: number;
}

export interface Memory {
  id: string;
  project_id: string;
  handle: string;
  title: string;
  content: string;
  memory_type_id: string;
  status_id: string;
  status_updated_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryChunk {
  id: string;
  memory_id: string;
  chunk_index: number;
  content: string;
}

export interface Tag {
  id: string;
  name: string;
  created_at: Date;
}

// Lightweight tag reference for embedding in memory responses
export interface TagRef {
  id: string;
  name: string;
}

export interface MemoryTag {
  memory_id: string;
  tag_id: string;
}

export interface CreateProjectInput {
  name: string;
  handle?: string;
  display_name?: string;
  description?: string;
  path?: string;
}

// For PATCH - partial updates (all optional, excludes immutable handle)
export interface UpdateProjectInput {
  name?: string;
  display_name?: string;
  description?: string;
  path?: string;
}

// For PUT - full resource replacement (requires name)
export interface FullProjectInput {
  name: string;
  display_name?: string;
  description?: string;
  path?: string;
}

export interface CreateMemoryInput {
  handle: string;
  title: string;
  content: string;
  type: MemoryType;
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface UpdateMemoryInput {
  project_id?: string;
  handle?: string;
  title?: string;
  content?: string;
  type?: MemoryType;
  parent_type?: string;
  status?: string;
  tags?: string[];
  metadata?: Record<string, string>;
}

// For PUT - full resource replacement (requires title, content, type)
export interface FullMemoryInput {
  title: string;
  content: string;
  type: MemoryType;
  parent_type?: string;
  tags?: string[];
}

export interface SetMemoryStatusInput {
  status: string;
}

export interface MemoryWithType extends Memory {
  type: MemoryType;
  parent_type?: string;
  parent_type_id?: string;
  status: string;
}

// Summary without content - for lightweight session context
export interface MemorySummary {
  id: string;
  project_id: string;
  handle?: string;
  title: string;
  type: MemoryType;
  parent_type?: string;
  parent_type_id?: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryTypeWithStatuses {
  type: MemoryType;
  description?: string;
  statuses: Array<{
    value: string;
    display_name?: string;
    description?: string;
    sort_order: number;
  }>;
}

export interface MemoryRelation {
  id: string;
  source_memory_id: string;
  target_memory_id: string;
  relation_type: RelationType;
  created_at: Date;
}

export interface CreateRelationInput {
  source_memory_id: string;
  target_memory_id: string;
  relation_type: RelationType;
}

// Comments
export type CommentStatus = 'active' | 'orphaned' | 'resolved';

// Author is either 'user' (human) or an assistant handle ('claude-code', 'codex-cli')
export type CommentAuthor = 'user' | string;

export interface Comment {
  id: string;
  entity_type: CommentEntityType;
  entity_id: string;
  content: string;
  author: CommentAuthor;
  updated_by?: string;
  parent_comment_id?: string;
  // Text-based anchoring (for memory/plan comments)
  anchor_text?: string;
  anchor_prefix?: string;
  anchor_suffix?: string;
  // Diff-specific anchoring (for diff comments)
  anchor_path?: string;
  anchor_line?: number;
  status: CommentStatus;
  created_at: Date;
  updated_at: Date;
}

export interface CreateCommentInput {
  content: string;
  author?: CommentAuthor;
  parent_comment_id?: string;
  // Text-based anchoring (for memory/plan comments)
  anchor_text?: string;
  anchor_prefix?: string;
  anchor_suffix?: string;
  // Diff-specific anchoring (for diff comments)
  anchor_path?: string;
  anchor_line?: number;
}

export interface UpdateCommentInput {
  content?: string;
  // Text-based anchoring (for memory/plan comments)
  anchor_text?: string;
  anchor_prefix?: string;
  anchor_suffix?: string;
  // Diff-specific anchoring (for diff comments)
  anchor_path?: string;
  anchor_line?: number;
  status?: CommentStatus;
}

export interface PaginationMetadata {
  total_count: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface PaginatedMemoriesResponse {
  memories: Memory[];
  pagination: PaginationMetadata;
}

export type SearchMode = 'all' | 'content' | 'tags';

export interface MemorySearchParams {
  type?: string;
  tag?: string;
  status?: string;
  q?: string;
  search_mode?: SearchMode;
  // Sorting
  sort?: string; // 'relevance' | 'updated_at' | 'created_at' | 'title'
  order?: string; // 'asc' | 'desc' (ignored for relevance)
  limit?: string;
  offset?: string;
  compact?: string;
  // Date filtering
  created_after?: string; // ISO date string (inclusive)
  created_before?: string; // ISO date string (inclusive)
  tz?: string; // IANA timezone (e.g., "America/Chicago") for date comparisons
}

// Compact memory for lightweight search responses
export interface CompactMemory {
  id: string;
  project_id: string;
  project_handle: string;
  project_name: string;
  handle: string;
  title: string;
  type: MemoryType;
  memory_type_id: string;
  parent_type?: string;
  parent_type_id?: string;
  status: string;
  tags: TagRef[];
  updated_at: Date;
  content_excerpt: string;
  score?: number;
}

export interface SessionContext {
  project: Project;
  todos: {
    recently_created: MemorySummary[];
    in_progress: MemorySummary[];
    recently_completed: MemorySummary[];
  };
  recent_decisions: MemorySummary[];
  recent_patterns: MemorySummary[];
  recent_context: MemorySummary[];
}

// Assistant Configuration types
export interface Assistant {
  id: string;
  handle: string;
  name: string;
  description?: string;
  created_at: Date;
  updated_at: Date;
}

export type ConfigScope = 'system' | 'global' | 'project' | 'local';
export type ConfigType = 'settings' | 'instructions' | 'rules' | 'knowledge' | 'glossary' | 'mcp' | 'state';
export type ConfigFormat = 'json' | 'markdown' | 'toml';

// Main config table - holds content and sync state
// Note: current_snapshot is computed from MAX(snapshot_number), not stored
export interface Config {
  id: string;
  scope: ConfigScope;
  type: ConfigType;
  path: string;
  format: ConfigFormat;
  content: string;
  file_hash?: string;
  version: number;
  auto_sync: boolean;
  readonly: boolean;
  parent_config_id?: string;
  is_import: boolean;
  notes?: string;
  last_synced_at?: Date;
  created_at: Date;
  updated_at: Date;
}

// Lightweight import reference
export interface ConfigImport {
  id: string;
  path: string;
  scope: ConfigScope;
  format: ConfigFormat;
  is_import: boolean;
}

// Config with assistant info (for user-wide configs)
export interface AssistantConfig extends Config {
  assistant: {
    id: string;
    handle: string;
    name: string;
  };
  imports?: ConfigImport[];
}

// Config with project and assistant info (for project-scoped configs)
export interface ProjectAssistantConfig extends Config {
  project: {
    id: string;
    handle: string;
    name: string;
  };
  assistant: {
    id: string;
    handle: string;
    name: string;
  };
}

// Sync status
export type SyncStatus = 'in_sync' | 'external_changes' | 'not_synced' | 'file_missing';

export interface SyncStatusResponse {
  status: SyncStatus;
  db_hash?: string;
  file_hash?: string;
  message?: string;
}

// Input types
export interface CreateConfigInput {
  scope: ConfigScope;
  type: ConfigType;
  path: string;
  format: ConfigFormat;
  content: string;
  auto_sync?: boolean;
}

export interface UpdateConfigInput {
  content?: string;
  auto_sync?: boolean;
  notes?: string;
}

// Session file management types (filesystem-based, no DB)
export interface SessionProject {
  dir_name: string;
  decoded_path: string;
  session_count: number;
  total_size: number;
  last_modified: string;
  matched_project?: {
    id: string;
    handle: string;
    name: string;
  };
}

export interface SessionFile {
  id: string;
  size: number;
  last_modified: string;
  has_companion: boolean;
  companion_size?: number;
  summary?: string;
  leaf_uuid?: string;
  search_excerpt?: string;
}

export interface SessionEntry {
  type: string;
  uuid?: string;
  timestamp?: string;
  [key: string]: any;
}
