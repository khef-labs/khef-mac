export type MemoryType =
  | 'user-note'
  | 'assistant-note'
  | 'project-note'
  | 'user-todo'
  | 'assistant-todo'
  | 'decision'
  | 'command'
  | 'commands'
  | 'context'
  | 'api'
  | 'pattern'
  | 'reference'
  | 'assistant-rule'
  | 'diagram'
  | 'csv'
  | 'video'
  | 'canvas'
  | 'widget'
  | 'animation'
  | 'prototype'
  | 'quiz'
  | 'google-doc'
  | 'knowledge'

export type TodoStatus = 'open' | 'in_progress' | 'done' | 'blocked' | 'canceled'
export type DecisionStatus = 'proposed' | 'accepted' | 'rejected' | 'superseded'
export type PatternStatus = 'proposed' | 'active' | 'deprecated'
export type ContextStatus = 'current' | 'updated' | 'outdated'
export type DiagramStatus = 'draft' | 'published' | 'archived'
export type CsvStatus = 'draft' | 'published' | 'archived'
export type VideoStatus = 'unwatched' | 'watched'
export type CanvasStatus = 'draft' | 'published' | 'archived'
export type GoogleDocStatus = 'synced' | 'unlinked' | 'outdated'

export type MemoryStatus = TodoStatus | DecisionStatus | PatternStatus | ContextStatus | DiagramStatus | CsvStatus | VideoStatus | CanvasStatus | GoogleDocStatus | string

// Forward relation types (used when creating relations)
export type RelationType =
  | 'supports'
  | 'contradicts'
  | 'depends_on'
  | 'follows_from'
  | 'references'
  | 'relates_to'
  | 'supersedes'
  | 'implements'
  | 'blocks'
  | 'extends'
  | 'duplicates'
  | 'clones'

// Contextual relation types (can be forward or inverse, returned by API)
export type ContextualRelationType =
  | RelationType
  | 'is_supported_by'
  | 'is_contradicted_by'
  | 'is_depended_on_by'
  | 'is_followed_by'
  | 'is_referenced_by'
  | 'is_superseded_by'
  | 'is_implemented_by'
  | 'is_blocked_by'
  | 'is_extended_by'
  | 'is_duplicated_by'
  | 'is_cloned_by'

// Relation type info from the API
export interface RelationTypeInfo {
  value: RelationType
  forward_label: string
  inverse_value: string
  inverse_label: string
}

export interface MemoryTypeStatusInfo {
  value: string
  display_name: string | null
  description: string | null
  sort_order: number | null
  usage_count?: number
}

export interface MemoryTypeInfo {
  type: MemoryType
  description: string | null
  usage_count: number
  statuses: MemoryTypeStatusInfo[]
  parent_type?: string
  children?: string[]
}

export interface ProjectMemoryTypesResponse {
  project_id: string
  project_handle: string
  memory_types: MemoryTypeInfo[]
}

export interface ProjectMemoryTypeStatusesResponse {
  project_id: string
  project_handle: string
  type: MemoryType
  statuses: MemoryTypeStatusInfo[]
}

export interface Project {
  id: string
  name: string
  handle: string
  display_name: string
  description: string | null
  path: string | null
  is_favorite: boolean
  created_at: string
  updated_at: string
}

export interface Memory {
  id: string
  project_id: string
  project_handle?: string
  handle: string
  title: string
  content: string
  content_excerpt?: string
  type: MemoryType
  parent_type?: string
  parent_type_id?: string
  status: MemoryStatus
  status_id: string
  memory_type_id: string
  status_updated_at: string
  created_at: string
  updated_at: string
  is_pinned?: boolean
  is_seeded?: boolean
  tags?: Tag[]
  comments?: Comment[]
  score?: number
  semantic_score?: number
  metadata?: Record<string, string>
}

export interface Tag {
  id: string
  name: string
}

// Raw relation from the database (for graph edges, etc.)
export interface Relation {
  id: string
  source_memory_id: string
  target_memory_id: string
  relation_type: RelationType
  created_at: string
}

// Flat relation format from GET /api/memories/:id/relations
export interface FlatRelation {
  id: string
  relation_type: ContextualRelationType
  relation_label: string
  created_at: string
  related_memory: {
    id: string
    handle: string
    title: string
    type: MemoryType
    parent_type?: string
    status: MemoryStatus
    project_id: string
    project_handle: string
    project_name: string
  }
}

export interface GraphNode {
  id: string
  title: string
  type: MemoryType
  parent_type?: string
  status: MemoryStatus
  content_excerpt?: string
  depth: number
  tags?: Tag[]
}

export interface GraphEdge {
  source: string
  target: string
  relation_type: RelationType
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  truncated: boolean
  total_nodes?: number
  total_edges?: number
  max_depth?: number
}

export interface Pagination {
  total_count?: number
  totalCount?: number
  limit: number
  offset: number
  has_more?: boolean
  hasMore?: boolean
}

export interface SearchParams {
  q?: string
  project_id?: string
  type?: MemoryType
  tag?: string
  handle?: string
  status?: string
  sort?: 'relevance' | 'updated_at' | 'created_at' | 'created_at_asc' | 'title'
  order?: 'asc' | 'desc'
  compact?: boolean
  limit?: number
  offset?: number
  search_mode?: 'content' | 'tags' | 'semantic'
  created_after?: string
  created_before?: string
  tz?: string // IANA timezone for date filtering
  pinned?: boolean
}

export interface SearchResponse {
  memories: Memory[]
  pagination: Pagination
}

export interface SessionContext {
  project: Project
  todos: {
    recently_created: Memory[]
    in_progress: Memory[]
    recently_completed: Memory[]
  }
  recent_decisions: Memory[]
  recent_patterns: Memory[]
  recent_context: Memory[]
}

export interface GraphHealth {
  orphan_count: number
  orphan_memories: Memory[]
  connected_components: {
    total: number
    isolated: number
    largest_size: number
  }
  relation_distribution: Record<RelationType, number>
  type_stats: Record<MemoryType, { count: number; orphans: number }>
}

// Comment types
export type CommentStatus = 'active' | 'orphaned' | 'resolved'

// Author is either 'user' (human) or an assistant handle ('claude-code', 'codex-cli')
export type CommentAuthor = 'user' | 'claude-code' | 'codex-cli'

// Entity type for comments (memory or plan)
export type CommentEntityType = 'memory' | 'plan'

export interface Comment {
  id: string
  memory_id?: string
  plan_id?: string
  entity_type?: CommentEntityType
  content: string
  author: CommentAuthor
  parent_comment_id?: string
  anchor_text?: string
  anchor_prefix?: string
  anchor_suffix?: string
  status: CommentStatus
  created_at: string
  updated_at: string
}

export interface CreateCommentInput {
  content: string
  author?: CommentAuthor
  parent_comment_id?: string
  anchor_text?: string
  anchor_prefix?: string
  anchor_suffix?: string
}

export interface UpdateCommentInput {
  content?: string
  anchor_text?: string
  anchor_prefix?: string
  anchor_suffix?: string
  status?: CommentStatus
}

export interface CommentsResponse {
  comments: Comment[]
  pagination: Pagination
}

// Assistant configuration types
export type ConfigScope = 'system' | 'global' | 'project' | 'local'
export type ConfigType = 'settings' | 'instructions' | 'rules' | 'knowledge' | 'glossary' | 'mcp' | 'state'
export type ConfigFormat = 'json' | 'markdown' | 'toml'

export interface Assistant {
  id: string
  handle: string
  name: string
  description?: string
}

// Note: current_snapshot is computed from MAX(snapshot_number), returned only from /snapshots endpoint
export interface Config {
  id: string
  scope: ConfigScope
  type: ConfigType
  path: string
  format: ConfigFormat
  content: string
  file_hash?: string
  auto_sync: boolean
  readonly: boolean
  is_import?: boolean
  parent_config_id?: string
  notes?: string | null
  last_synced_at?: string
  created_at: string
  updated_at: string
  version: number
}

export interface ConfigImport {
  id: string
  path: string
  scope: ConfigScope
  format: ConfigFormat
  is_import: boolean
}

export interface AssistantConfig extends Config {
  assistant: {
    id: string
    handle: string
    name: string
  }
  imports?: ConfigImport[]
}

export interface ProjectAssistantConfig extends Config {
  project: {
    id: string
    handle: string
    name: string
  }
  assistant: {
    id: string
    handle: string
    name: string
  }
}

export interface AssistantConfigSyncStatus {
  status: 'in_sync' | 'external_changes' | 'file_missing' | 'not_synced'
  db_hash?: string
  file_hash?: string
  message?: string
}

// MCP Server types
export type McpServerStatus = 'available' | 'stale' | 'unavailable' | 'unknown'

export interface McpServer {
  name: string
  type: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  status: McpServerStatus
  statusMessage?: string
}

export interface McpServersResponse {
  servers: McpServer[]
  configPath: string
  issues: number
}

export interface McpServersHealthResponse {
  issues: number
  assistants: {
    handle: string
    name: string
    issues: number
    servers: McpServer[]
  }[]
}

// Agent types
export type AgentModel = 'sonnet' | 'opus' | 'haiku' | 'inherit'
export type AgentPermissionMode = 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan'

export interface Agent {
  name: string
  description: string
  model?: AgentModel
  tools?: string[]
  disallowedTools?: string[]
  permissionMode?: AgentPermissionMode
  skills?: string[]
  prompt: string
  filePath: string
  scope: 'user' | 'project'
}

export interface AgentConfig {
  agents: Agent[]
  userAgentsPath?: string
  projectAgentsPath?: string
  agentsPath?: string  // Generic path returned by project agents endpoint
}

// Command types (slash commands / skills)
export type CommandType = 'command' | 'skill' | 'prompt'
export type CommandScope = 'user' | 'project'

export interface Command {
  assistant_handle: string
  type: CommandType
  scope: CommandScope
  name: string
  description: string | null
  content: string
  file_path: string
  hash: string
}

export interface CommandsResponse {
  commands: Command[]
}

// Session types
export interface SessionProject {
  dir_name: string
  decoded_path: string
  session_count: number
  total_size: number
  last_modified: string
  matched_project?: { id: string; handle: string; name: string } | null
}

export interface SessionFile {
  id: string
  size: number
  last_modified: string
  has_companion: boolean
  has_conversation?: boolean
  companion_size?: number
  summary?: string
  leaf_uuid?: string
  search_excerpt?: string
}

export interface SessionContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  text?: string
  thinking?: string
  name?: string
  input?: any
  tool_use_id?: string
  content?: any
  [key: string]: any
}

export interface SessionEntry {
  type: string
  uuid?: string
  timestamp?: string
  message?: {
    role: string
    content: string | SessionContentBlock[]
    model?: string
    usage?: { input_tokens: number; output_tokens: number }
  }
  summary?: string
  leafUuid?: string
  snapshot?: any
  [key: string]: any
}

export interface SessionProjectsResponse {
  projects: SessionProject[]
  total_size: number
  total_sessions: number
}

export interface SessionListResponse {
  sessions: SessionFile[]
  pagination: Pagination
}

export interface SessionFileDetailResponse {
  session: {
    id: string
    size: number
    entry_count: number
    entries: SessionEntry[]
    source?: 'original' | 'backup'
    file_path?: string
  }
  pagination: Pagination
}

export interface BulkDeleteResponse {
  deleted: number
  freed_bytes: number
}

// Session search types (ChromaDB-based)
export interface SessionSearchResult {
  session_id: string
  project_dir: string
  assistant_handle: string
  chunk_index: number
  chunk_count: number
  summary: string
  score: number
  content: string
  nickname?: string
  db_id?: string
}

export interface SessionSearchResponse {
  results: SessionSearchResult[]
}

// Session keyword search types (PostgreSQL-based)
export interface SessionKeywordSearchResult {
  id: string
  session_id: string
  nickname: string | null
  assistant_handle: string
  project_id: string | null
  project_handle: string | null
  name: string | null
  summary: string | null
  chunk_index: number
  excerpt: string
  rank: number
}

export interface SessionKeywordSearchResponse {
  results: SessionKeywordSearchResult[]
  query: string
}

// Session detail (from PostgreSQL)
export interface SessionChunk {
  id: string
  chunk_index: number
  content: string
  message_count: number | null
}

export interface SessionDetail {
  id: string
  session_id: string
  assistant: {
    handle: string
    name: string
  }
  project: {
    id: string
    handle: string | null
    display_name: string | null
    name: string | null
  } | null
  name: string | null
  nickname: string | null
  summary: string | null
  message_count: number | null
  file_size: number
  file_path: string
  chunk_count: number
  started_at: string | null
  ended_at: string | null
  created_at: string
  updated_at: string
  model: string | null
  total_input_tokens: number | null
  total_output_tokens: number | null
  context_window_tokens: number | null
  pid: number | null
  status: string | null
  search_excerpt?: string
  resumable?: boolean
}

export interface SessionDetailResponse {
  session: SessionDetail
  chunks?: SessionChunk[]
}

// Backward-compat aliases
export type SyncedSessionDetail = SessionDetail
export type SyncedSessionChunk = SessionChunk
export type SyncedSessionDetailResponse = SessionDetailResponse
export type SyncedSession = SessionDetail

export interface SessionsResponse {
  sessions: SessionDetail[]
  pagination: {
    total: number
    limit: number
    offset: number
  }
}

// Backward-compat alias
export type SyncedSessionsResponse = SessionsResponse

export interface SessionSyncStatus {
  embedded_sessions: number
  total_chunks: number
  last_sync: string | null
}

export interface SessionSyncResult {
  synced: number
  skipped: number
  errors: number
  chunks_created: number
}

// Active session types
export interface ActiveSession {
  id: string
  session_id: string
  assistant: { id: string; handle: string; name: string }
  project: { id: string; handle: string; name: string } | null
  file_path: string
  project_dir: string | null
  pid: number | null
  pid_is_self: boolean
  nickname: string | null
  status: 'active' | 'inactive'
  last_seen_at: string | null
  first_seen_at: string | null
  created_at: string | null
  updated_at: string | null
  transcript: {
    synced_session_id: string
    name: string | null
    summary: string | null
    message_count: number | null
    started_at: string | null
    ended_at: string | null
    model: string | null
    context_window_tokens: number | null
  } | null
}

export interface ActiveSessionsResponse {
  sessions: ActiveSession[]
  count: number
  scanned_count?: number
}

// Plan types
export interface PlanSummary {
  id: string
  filename: string
  file_path: string
  title: string
  current_version: number
  version_count: number
  status: string
  has_file: boolean
  size: number
  created_at: string
  updated_at: string
  project_id?: string | null
  project_handle?: string | null
  project_name?: string | null
}

export interface Plan extends PlanSummary {
  content: string
}

export interface PlansResponse {
  plans: PlanSummary[]
}

export interface PlanResponse {
  plan: Plan
}

export interface PlanVersion {
  id: string
  version: number
  title: string
  content?: string
  size: number
  created_at: string
}

export interface PlanVersionsResponse {
  versions: PlanVersion[]
}

export interface PlanVersionResponse {
  version: PlanVersion
}

// Config Snapshot types
export interface ConfigSnapshot {
  id: string
  snapshot_number: number
  content: string
  content_hash: string
  content_type: 'json' | 'markdown' | 'toml' | null
  content_json: Record<string, unknown> | null
  source: 'manual' | 'import' | 'pre-sync'
  size: number | null
  created_at: string
}

export interface ConfigSnapshotSummary {
  snapshot_number: number
  size: number | null
  content_hash: string
  content_type: 'json' | 'markdown' | 'toml' | null
  source: 'manual' | 'import' | 'pre-sync'
  created_at: string
}

export interface ConfigSnapshotsResponse {
  current_snapshot: number
  snapshots: ConfigSnapshotSummary[]
}

export interface ConfigSnapshotResponse {
  snapshot: ConfigSnapshot
}

export interface ConfigRestoreResponse {
  status: 'restored'
  new_snapshot: number
  synced_to_disk: boolean
}

export interface ConfigCreateSnapshotResponse {
  snapshot_number: number
}

// Git/Diff types
export interface Commit {
  sha: string
  short_sha: string
  message: string
  body: string | null
  author: string
  author_email: string
  date: string
  comment_count?: number
  stats?: {
    files: number
    insertions: number
    deletions: number
  }
}

export interface CommitsResponse {
  commits: Commit[]
  branch: string
  pagination?: Pagination
}

export interface DiffFile {
  path: string
  old_path?: string
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  additions: number
  deletions: number
}

export interface Diff {
  id: string
  project_id: string
  commit_sha: string | null  // null = uncommitted/working tree changes
  content: string
  files: DiffFile[]
  comments?: DiffComment[]
  created_at: string
  updated_at: string
}

export interface DiffResponse {
  diff: Diff
}

// Diff comments extend base comment with line-based anchoring
export interface DiffComment extends Comment {
  diff_id: string
  anchor_path?: string  // File path in diff
  anchor_line?: number  // Line number in diff
}

export interface CreateDiffCommentInput {
  content: string
  author?: CommentAuthor
  parent_comment_id?: string
  anchor_path?: string
  anchor_line?: number
}

export interface UpdateDiffCommentInput {
  content?: string
  anchor_path?: string
  anchor_line?: number
  status?: CommentStatus
}

export interface DiffCommentsResponse {
  comments: DiffComment[]
  pagination: Pagination
}

// Stats
export interface StatsProcessInstance {
  pid: number
  name?: string
  rss: number
  rss_human: string
  cpu: number
  session_nickname?: string
  session_id?: string
}

export interface StatsProcessGroup {
  name: string
  count: number
  rss: number
  rss_human: string
  cpu: number
  instances: StatsProcessInstance[]
}

export interface StatsOverviewResponse {
  memories: {
    total: number
    by_type: { type: string; count: number }[]
    by_project: { id: string; handle: string; name: string; count: number }[]
    oldest: string | null
    newest: string | null
  }
  projects: { total: number }
  tags: {
    total: number
    top: { name: string; count: number }[]
  }
  relations: {
    total: number
    by_type: { type: string; count: number }[]
  }
  files: {
    total: number
    total_size: number
  }
  database: {
    size: number
    size_human: string
  }
  health: {
    stale_todos: number
    orphan_count: number
    connected_count: number
    pending_decisions: number
    total_memories: number
  }
}

export interface StatsMemoryResponse {
  daily_counts: { date: string; count: number }[]
  status_breakdown: {
    type: string
    total: number
    statuses: { status: string; count: number }[]
  }[]
}

export interface StatsUsageResponse {
  total_sessions: number
  total_input_tokens: number
  total_output_tokens: number
  total_cache_creation_tokens: number
  total_cache_read_tokens: number
  cache_hit_rate: number
  estimated_cost: number
  by_model: { model: string; session_count: number; total_tokens: number }[]
  by_project: { id: string | null; project: string; name: string; session_count: number; total_tokens: number; estimated_cost: number }[]
  weekly_usage: { week: string; input_tokens: number; output_tokens: number; cache_read_tokens: number }[]
  recent_sessions: {
    nickname: string | null
    project: string | null
    project_name: string | null
    model: string | null
    messages: number
    total_input: number
    total_output: number
    context_window_tokens: number | null
    started_at: string | null
    ended_at: string | null
  }[]
}

export interface StatsSystemResponse {
  processes: {
    processes: StatsProcessGroup[]
    total_rss: number
    total_rss_human: string
  }
  system_processes: {
    apps: StatsProcessGroup[]
    total_rss: number
    total_rss_human: string
  }
}

// Aggregate response from `GET /api/stats` (kept for MCP `get_stats` and
// integration tests). UI uses the per-tab sub-endpoints instead.
export interface StatsResponse extends StatsOverviewResponse {
  memory_analysis?: StatsMemoryResponse
  claude_usage?: StatsUsageResponse
  processes?: StatsSystemResponse['processes']
  system_processes?: StatsSystemResponse['system_processes']
}

export interface RuntimePort {
  service: string
  host: string
  host_port: number
  protocol: 'tcp' | 'udp'
  source: 'host' | 'docker'
  container_name?: string
  container_port?: number
}

export interface RuntimeContainer {
  id: string
  name: string
  image: string
  status: string
  ports: string
  labels: string
}

export interface RuntimeImage {
  repository: string
  tag: string
  id: string
  created_since: string
  size: string
  in_use: boolean
}

export interface RuntimeVolume {
  name: string
  type: string
  source: string
  destination: string
  driver: string | null
  size: string | null
  size_bytes: number | null
  containers: string[]
}

export interface RuntimeHuggingFaceModel {
  model: string
  cache_path: string
  size: string | null
  size_bytes: number | null
}

export interface SettingsRuntimeResponse {
  generated_at: string
  ports: RuntimePort[]
  docker: {
    available: boolean
    error?: string
    containers: RuntimeContainer[]
    images: RuntimeImage[]
    volumes: RuntimeVolume[]
  }
  huggingface: {
    embed_server_available: boolean
    active_model: string | null
    dimensions: number | null
    cache_dir: string
    cache_exists: boolean
    cache_size: string | null
    cache_size_bytes: number | null
    models: RuntimeHuggingFaceModel[]
  }
}

// ============ Memory Files (auto-memory) ============

export interface MemoryFileSummary {
  id: string
  filename: string
  file_path: string | null
  current_snapshot: number
  snapshot_count: number
  has_file: boolean
  is_main: boolean
  size: number
  created_at: string
  updated_at: string
}

export interface MemoryFile extends MemoryFileSummary {
  content: string
  project_id: string | null
  project_name: string | null
  project_dir: string
}

export interface MemoryFileSnapshot {
  snapshot_number: number
  size: number
  file_hash: string
  created_at: string
  content?: string
}

export interface MemoryFilesResponse {
  files: MemoryFileSummary[]
}

export interface MemoryFileResponse {
  file: MemoryFile
}

export interface MemoryFileSnapshotsResponse {
  snapshots: MemoryFileSnapshot[]
}

export interface MemoryProject {
  dir_name: string
  decoded_path: string
  file_count: number
  total_size: number
  last_modified: string | null
  matched_project: { id: string; name: string; handle: string } | null
}

export interface MemoryProjectsResponse {
  projects: MemoryProject[]
}

// ============ Google Integration ============

export interface GoogleStatus {
  available: boolean
  reason?: 'gcloud_not_installed' | 'gcloud_not_authenticated'
  email?: string
}

export interface GcloudAccount {
  account: string
  active: boolean
}

export interface GcloudAccountsResponse {
  accounts: GcloudAccount[]
  active_account: string | null
}

export interface GcloudSetAccountResponse {
  account: string
  message: string
}

export interface GcloudHealthCheck {
  name: string
  passed: boolean
  message?: string
  duration_ms: number
}

export interface GcloudHealthResponse {
  healthy: boolean
  gcloud_installed: boolean
  authenticated: boolean
  drive_access: boolean
  active_account?: string
  account?: string
  vertex_account?: string
  drive_account?: string
  error?: string
  account_checks: {
    account: string
    active: boolean
    healthy: boolean
    authenticated: boolean
    drive_access: boolean
    error?: string
  }[]
  checks: GcloudHealthCheck[]
}

export interface GoogleComment {
  id: string
  author: string
  content: string
  quotedText: string | null
  createdTime: string
  resolved: boolean
  replies: {
    id: string
    author: string
    content: string
    createdTime: string
  }[]
}

export interface GoogleDocContent {
  id: string
  title: string
  content: string
  url: string
  comments: GoogleComment[]
}

export interface GoogleDocImportInput {
  project_id: string
  handle?: string
  type?: MemoryType
  tags?: string[]
  includeComments?: boolean
  // Optional tab ID (e.g., "t.abc123") for importing a single tab of a multi-tab Google Doc.
  tab_id?: string
}

export interface GoogleDocImportResponse {
  memory: {
    id: string
    handle: string
    title: string
    type: MemoryType
    project_id: string
    created_at: string
    updated_at: string
    external_source: {
      type: 'google-doc'
      id: string
      url: string
      last_synced_at: string
    }
    comments_imported: number
  }
}

export interface ExternalSyncResponse {
  id: string
  synced: boolean
  mode: 'update' | 'snapshot'
  snapshot: number
  last_synced_at: string
  comments_synced: number
  source: {
    type: string
    id: string
    url: string
  }
}

// ============ Prompts ============

export type PromptType = 'agent' | 'command' | 'prompt'

export interface PromptAssistant {
  assistant_id: string
  assistant_handle: string
  prompt_type: PromptType
  source_path: string | null
  file_hash: string | null
}

export interface Prompt {
  id: string
  handle: string
  title: string
  content: string
  description: string | null
  created_at: string
  updated_at: string
  current_snapshot?: number
  assistants: PromptAssistant[]
}

export interface PromptSnapshot {
  id: string
  prompt_id: string
  snapshot_number: number
  content?: string
  content_hash: string
  source: 'manual' | 'pre-sync'
  created_at: string
}

export interface PromptSyncStatus {
  assistant: string
  path: string
  status: 'synced' | 'modified_externally' | 'missing'
  db_hash: string | null
  file_hash: string | null
}

export interface PromptsResponse {
  prompts: Prompt[]
  pagination: Pagination
}

export interface PromptResponse {
  prompt: Prompt
}

export interface PromptSnapshotsResponse {
  snapshots: PromptSnapshot[]
}

export interface SnapshotDiffChange {
  type: 'equal' | 'add' | 'remove' | 'skip'
  value: string
  lines_skipped?: number
}

export interface PromptSnapshotDiffResponse {
  prompt_id: string
  from: { snapshot_number: number; source: string | null; created_at: string }
  to: { snapshot_number: number; source: string | null; created_at: string }
  changes: SnapshotDiffChange[]
  stats: { additions: number; deletions: number; unchanged: number }
}

export interface PromptDiscoverResult {
  assistant: string
  type: string
  action: 'created' | 'updated' | 'unchanged'
  handle: string
  path: string
}

export interface PromptDiscoverResponse {
  results: PromptDiscoverResult[]
  total: number
}

export interface PromptSyncResult {
  synced: Array<{ assistant: string; path: string }>
  conflicts: Array<{ assistant: string; path: string; db_hash: string | null; file_hash: string }>
}

// Gemini types
export interface GeminiSettings {
  project: string
  location: string
  defaultModel: string
  account: string
}

export interface GeminiStatus {
  available: boolean
  reason?: string
  project?: string
  location?: string
  model?: string
  account?: string
}

export interface GeminiConversation {
  id: string
  title: string | null
  project_id: string | null
  project_handle?: string
  project_name?: string
  message_count?: number
  created_at: string
  updated_at: string
}

export interface GeminiGroundingSource {
  uri: string
  title: string
}

export interface GeminiGrounding {
  searchQueries: string[]
  sources: GeminiGroundingSource[]
}

export interface GeminiThinking {
  text: string
  tokenCount: number
}

export interface GeminiContentPart {
  text: string
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiContentPart[]
}

export interface GeminiResponsePart {
  type: 'text' | 'file'
  text?: string
  fileId?: string
  mimeType?: string
}

export interface GeminiMessage {
  id: string
  conversation_id: string
  prompt_id: string | null
  prompt_text: string
  response: string | null
  response_parts: GeminiResponsePart[] | null
  model: string
  input_tokens: number | null
  output_tokens: number | null
  error: string | null
  grounding: GeminiGrounding | null
  thinking: GeminiThinking | null
  created_at: string
}

export interface GeminiConversationWithMessages extends GeminiConversation {
  messages: GeminiMessage[]
}

export interface GeminiConversationsResponse {
  conversations: GeminiConversation[]
  pagination: Pagination
}

export interface GeminiConversationResponse {
  conversation: GeminiConversationWithMessages
}

export interface GeminiMessageResponse {
  message: GeminiMessage
  error?: string
}

export interface GeminiGenerateResponse {
  response: string
  model: string
  input_tokens: number
  output_tokens: number
  grounding?: GeminiGrounding
  thinking?: GeminiThinking
}

export interface GeminiGenerateInput {
  prompt_text: string
  contents?: GeminiContent[]
  model?: string
  temperature?: number
  max_output_tokens?: number
  use_google_search?: boolean
  use_thinking?: boolean
  thinking_budget?: number
}

// ============ Kdag Jobs ============

export type KdagJobStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed'

export interface KdagJobStepProgress {
  total: number
  completed: number
}

export interface KdagJobRun {
  id: string
  status: KdagJobStatus
  model: string | null
  exit_code: number | null
  error: string | null
  duration_ms: number | null
  step_count: number
  steps_completed: number
  started_at: string | null
  completed_at: string | null
  created_at: string
}

export interface KdagJob {
  id: string
  job_type: string
  requested_by: string
  assistant_handle: string
  project_id: string | null
  project_handle: string | null
  project_name: string | null
  definition_key: string | null
  definition_name: string | null
  latest_run: KdagJobRun | null
  created_at: string
}

export interface KdagJobInput {
  id: string
  input_type: string
  content_length: number
  content?: string
  ref_type: string | null
  ref_id: string | null
}

export interface KdagJobStep {
  id: string
  definition_step_index: number
  definition_step_key: string | null
  definition_step_name: string | null
  step_index: number
  step_type: string
  input_chars: number | null
  input_text?: string
  status: string
  duration_ms: number | null
  output_preview: string | null
  output_length: number | null
  metadata: {
    backend?: string
    model?: string
    timeout_ms?: number
    grounding?: any
    allowed_tools?: string[]
    command?: string
    script?: string
  } | null
  created_at: string
}

export interface KdagJobRunDetail extends KdagJobRun {
  steps: KdagJobStep[]
  output: string | null
}

export interface KdagJobDetailResponse {
  job: Omit<KdagJob, 'latest_run'>
  inputs: KdagJobInput[]
  runs: KdagJobRunDetail[]
  output: string | null
}

export interface KdagJobListResponse {
  jobs: KdagJob[]
  pagination: Pagination
  status_counts?: Record<string, number>
}

// ============ Kdag Backends ============

export interface KdagBackend {
  key: string
  name: string
  available: boolean
  reason?: string
  models: string[]
}

// ============ Job Definitions ============

export interface JobDefinitionStep {
  id?: string
  step_index: number
  key: string
  name: string
  step_type: string
  assistant_handle: string | null
  model: string | null
  prompt_handle: string | null
  input_source: string
  input_config: Record<string, unknown>
  config: Record<string, unknown>
  timeout_ms: number
}

export interface KdagInputType {
  id: string
  key: string
  description: string | null
  format: string | null
}

export interface JobDefinitionInput {
  id?: string
  input_type: string
  required: boolean
  description: string | null
}

export interface JobDefinitionSummary {
  id: string
  key: string
  name: string
  description: string | null
  is_system: boolean
  step_count: number
  job_count: number
  last_used_at: string | null
  created_at: string
  updated_at: string
}

export interface JobDefinitionDetail {
  definition: {
    id: string
    key: string
    name: string
    description: string | null
    is_system: boolean
    created_at: string
    updated_at: string
  }
  steps: JobDefinitionStep[]
  inputs: JobDefinitionInput[]
}

export interface SessionSummary {
  id: string
  content: string
  assistant_handle: string
  created_at: string
  updated_at: string
}

export interface SessionSummarySnapshot {
  id: string
  assistant_handle: string
  created_at: string
}

export interface SessionSummaryResponse {
  summary: SessionSummary | null
  snapshots: SessionSummarySnapshot[]
  job: {
    id: string
    run_id: string | null
    status: KdagJobStatus
    error: string | null
    duration_ms: number | null
    created_at: string
    step_progress: KdagJobStepProgress | null
  } | null
}

// ============ kvec (Vector Collections) ============

export interface KvecCollection {
  id: string
  name: string
  description: string | null
  embedding_model: string
  dimensions: number
  store_type: string
  created_at: string
  updated_at: string
  file_count: number
  total_chunks: number
  total_bytes: number
  repo_count: number
  branch_count: number
  last_upload: string | null
}

export interface KvecRepo {
  id: string
  collection_id: string
  name: string
  root_path: string
  remote_url: string | null
  created_at: string
  updated_at: string
  file_count: number
  snapshot_count: number
  last_upload: string | null
}

export interface KvecFile {
  id: string
  file_path: string
  content_hash: string
  file_size: number
  language: string | null
  status: string
  error_message: string | null
  uploaded_at: string
  updated_at: string
  chunk_count: number
  total_token_count: number
  chunk_methods: string[] | null
  repo_name: string | null
  branch: string | null
  commit_hash: string | null
}

export interface KvecLanguageStat {
  language: string
  count: number
}

export interface KvecCollectionsResponse {
  collections: KvecCollection[]
}

export interface KvecCollectionResponse {
  collection: KvecCollection
}

export interface KvecReposResponse {
  repos: KvecRepo[]
}

export interface KvecDocPath {
  dir_path: string
  file_count: number
  last_upload: string
}

export interface KvecDocPathsResponse {
  paths: KvecDocPath[]
}

export interface KvecFilesResponse {
  files: KvecFile[]
  pagination: Pagination
}

export interface KvecLanguagesResponse {
  languages: KvecLanguageStat[]
}

// ============ kvec Embed Jobs ============

export interface EmbedHealth {
  available: boolean
  model?: string
  dimensions?: number
  error?: string
}

export interface EmbedJobProgress {
  filesProcessed: number
  filesSkipped: number
  filesErrored: number
  chunksCreated: number
  totalFiles: number
}

export type EmbedJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface EmbedJob {
  id: string
  jobType: 'source' | 'commits'
  status: EmbedJobStatus
  path: string
  extensions: string[]
  batchSize: number
  batchDelayMs: number
  progress: EmbedJobProgress
  error?: string
  startedAt?: string
  completedAt?: string
}

export interface EmbedJobResponse {
  job: EmbedJob
}

export interface EmbedJobsResponse {
  jobs: EmbedJob[]
}

// ============ Kvec Auto-Embed Types ============

export type AutoEmbedJobType = 'commits' | 'source'

export interface AutoEmbedConfig {
  id: string
  repo_path: string
  branch: string
  job_type: AutoEmbedJobType
  enabled: boolean
  batch_delay_ms: number
  last_run_at: string | null
  last_commit_hash: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface AutoEmbedConfigsResponse {
  configs: AutoEmbedConfig[]
}

export interface AutoEmbedConfigResponse {
  config: AutoEmbedConfig
}

// ============ Commit Search Types ============

export interface CommitSearchResult {
  sha: string
  short_sha: string
  message: string
  author: string
  date: string
  repo: string
  score: number
  content: string
}

export interface CommitSearchResponse {
  results: CommitSearchResult[]
  pagination: Pagination
}

// ============ Slack Search Types ============

export interface SlackSearchResult {
  content: string
  score: number
  document_id: string
  chunk_index: number
  metadata: Record<string, unknown>
}

export interface SlackSearchResponse {
  results: SlackSearchResult[]
  total_count: number
}

export interface SlackDocumentListItem {
  id: string
  document_id: string
  content_hash?: string
  file_size: number
  language?: string
  status?: string
  metadata: Record<string, unknown> | null
  uploaded_at: string
  updated_at: string
  chunk_count: number
}

export interface SlackDocumentsResponse {
  documents: SlackDocumentListItem[]
  pagination: Pagination
}

// ============ Slack Channels ============

export interface SlackChannel {
  id: string
  channel_id: string
  workspace_id: string
  workspace_name: string | null
  channel_name: string
  channel_type: string
  export_path: string | null
  last_message_ts: string | null
  last_exported_at: string | null
  message_count: number
  created_at: string
  updated_at: string
}

// ============ Source Code Search Types ============

export interface SourceCodeSearchResult {
  file_path: string
  content: string
  score: number
  language: string
  chunk_index: number
  metadata: Record<string, unknown>
}

export interface SourceCodeSearchResponse {
  results: SourceCodeSearchResult[]
  total_count: number
}

export interface SourceCodeFacetsResponse {
  repos: string[]
  languages: string[]
  branches: string[]
}

// ============ Doc Search Types ============

export interface DocSearchResult {
  file_path: string
  title: string | null
  content: string
  score: number
  file_type: string | null
  project_handle: string | null
  tags: string[]
  source_path: string | null
}

export interface DocSearchResponse {
  results: DocSearchResult[]
  total_count: number
}

export interface DocFacetsResponse {
  projects: string[]
  file_types: string[]
  tags: string[]
}

// ============ Assistant Chat Types ============

export interface AssistantChat {
  id: string
  assistant_handle: string
  title: string | null
  project_id: string | null
  parent_chat_id?: string | null
  session_id: string | null
  source?: string
  caller_handle?: string | null
  project_handle?: string
  project_name?: string
  message_count: number
  created_at: string
  updated_at: string
}

export interface AssistantChatResponsePart {
  type: 'text' | 'file'
  text?: string
  fileId?: string
  mimeType?: string
}

export interface AssistantChatMessage {
  id: string
  chat_id: string
  prompt_text: string
  response: string | null
  response_parts: AssistantChatResponsePart[] | null
  model: string
  input_tokens: number | null
  output_tokens: number | null
  error: string | null
  status: 'pending' | 'completed' | 'failed'
  created_at: string
  updated_at: string
}

export interface SendChatBody {
  chat_id?: string
  prompt_text: string
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>
  model?: string
  project_id?: string
  title?: string
  session_id?: string
  system_prompt?: string
  voice_mode?: boolean
  source?: string
  use_google_search?: boolean
  use_thinking?: boolean
  thinking_budget?: number
}

export interface SendChatResponse {
  chat_id: string
  turn_id: string
  message: AssistantChatMessage
  session_id?: string
  error?: string
}

export interface AssistantChatsResponse {
  chats: AssistantChat[]
  pagination: Pagination
}

export interface ChatDelegation {
  chat: AssistantChat
  messages: AssistantChatMessage[]
  delegated_handle: string
}

export interface AssistantChatDetailResponse {
  chat: AssistantChat & {
    messages?: AssistantChatMessage[]
    delegations?: Record<string, ChatDelegation[]>
  }
}

export interface AssistantChatMessagesResponse {
  messages: AssistantChatMessage[]
  pagination: Pagination
}

// ============ Collections ============

export type CollectionViewMode = 'list' | 'board' | 'grid'

export interface BoardConfig {
  hiddenColumns?: string[]
  columnOrder?: string[]
}

export interface CollectionChild {
  id: string
  handle: string
  name: string
  description: string | null
  view_mode: CollectionViewMode
  memory_count: number
}

export interface Collection {
  id: string
  project_id: string
  handle: string
  name: string
  description: string | null
  parent_id: string | null
  view_mode: CollectionViewMode
  board_config: BoardConfig
  memory_count: number
  child_count?: number
  children?: CollectionChild[]
  created_at: string
  updated_at: string
}

export interface CollectionMemoryItem {
  id: string
  handle: string
  title: string
  type: string
  parent_type: string | null
  status: string | null
  content_excerpt: string
  tags: { id: string; name: string }[]
  metadata?: Record<string, string>
  display_project?: string
  position: number
  added_at: string
  created_at: string
  updated_at: string
}

export interface CollectionDetail extends Collection {
  children: CollectionChild[]
  memories: CollectionMemoryItem[]
}

export interface BoardColumn {
  status_id: string
  status_value: string
  display_name: string
  sort_order: number
  memories: CollectionMemoryItem[]
}

export interface BoardResponse {
  collection: {
    id: string
    handle: string
    name: string
    description: string | null
    parent_id: string | null
    view_mode: CollectionViewMode
    board_config: BoardConfig
  }
  columns: BoardColumn[]
}

export interface CollectionsResponse {
  collections: Collection[]
  pagination: Pagination
}

export interface CollectionResponse {
  collection: CollectionDetail
}

// ============ Filesystem Types ============

export interface FsEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modified?: string
  children?: FsEntry[]
}

export interface FsTreeResponse {
  path: string
  entries: FsEntry[]
}

export interface FsFindFile {
  name: string
  path: string
  relativePath: string
}

export interface FsFindResponse {
  root: string
  files: FsFindFile[]
}

export interface FsReadResponse {
  path: string
  content: string
  size: number
  language: string
  modified: string
  isImage?: boolean
  mimeType?: string
  base64Content?: string
}

export interface FsWriteResponse {
  path: string
  size: number
  modified: string
}

export interface FsStatResponse {
  path: string
  type: string
  size: number
  modified: string
  exists: boolean
}

export interface FsNewResponse {
  path: string
  type: 'file' | 'directory'
  size: number
  modified: string
}

export interface FsDeleteResponse {
  path: string
  deleted: boolean
}

export interface FsCompletion {
  name: string
  path: string
}

export interface FsCompletionsResponse {
  completions: FsCompletion[]
}

export interface FsSearchMatch {
  lineNumber: number
  lineText: string
  matchStart: number
  matchEnd: number
}

export interface FsSearchFileResult {
  path: string
  relativePath: string
  matches: FsSearchMatch[]
}

export interface FsSearchResponse {
  results: FsSearchFileResult[]
  truncated: boolean
}

export interface WithinMemorySearchHit {
  excerpt: string
  match_start: number
  match_end: number
}

export interface WithinMemorySearchSection {
  heading: string
  level: number
  start: number
  end: number
  hits: WithinMemorySearchHit[]
}

export interface WithinMemorySearchResult {
  memory_id: string
  title: string
  query: string
  match_count: number
  sections: WithinMemorySearchSection[]
}
