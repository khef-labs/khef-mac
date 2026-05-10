import ky from 'ky'
import type {
  Project,
  Memory,
  Tag,
  Relation,
  FlatRelation,
  GraphData,
  SearchParams,
  SearchResponse,
  Pagination,
  SessionContext,
  GraphHealth,
  MemoryType,
  MemoryStatus,
  ProjectMemoryTypesResponse,
  ProjectMemoryTypeStatusesResponse,
  ContextualRelationType,
  RelationTypeInfo,
  Comment,
  CreateCommentInput,
  UpdateCommentInput,
  CommentsResponse,
  CommentStatus,
  Assistant,
  AssistantConfig,
  AssistantConfigSyncStatus,
  ProjectAssistantConfig,
  McpServer,
  McpServersResponse,
  McpServersHealthResponse,
  Agent,
  AgentConfig,
  AgentModel,
  AgentPermissionMode,
  Command,
  CommandsResponse,
  CommandType,
  CommandScope,
  StatsResponse,
  StatsOverviewResponse,
  StatsMemoryResponse,
  StatsUsageResponse,
  StatsSystemResponse,
  SessionProjectsResponse,
  SessionListResponse,
  SessionFileDetailResponse,
  SessionDetailResponse,
  SessionsResponse,
  SessionSearchResponse,
  SessionKeywordSearchResponse,
  SessionSyncStatus,
  SessionSyncResult,
  ActiveSessionsResponse,
  BulkDeleteResponse,
  CommitsResponse,
  Diff,
  DiffComment,
  CreateDiffCommentInput,
  UpdateDiffCommentInput,
  DiffCommentsResponse,
  GoogleStatus,
  GcloudAccountsResponse,
  GcloudHealthResponse,
  GcloudSetAccountResponse,
  GoogleDocContent,
  GoogleDocImportInput,
  GoogleDocImportResponse,
  ExternalSyncResponse,
  SettingsRuntimeResponse,
  WithinMemorySearchResult,
} from '../types'

export { API_BASE } from './apiBase'
import { API_BASE } from './apiBase'
import { subscribe as sseSubscribe } from './sseClient'

const client = ky.create({
  prefixUrl: API_BASE,
  timeout: 30000,
  hooks: {
    beforeError: [
      async (error) => {
        const { response } = error
        if (response) {
          // Try to extract error message from response body
          try {
            const body = await response.clone().json()
            if (body?.error && typeof body.error === 'string') {
              error.message = body.error
            }
          } catch {
            // Ignore parsing errors, keep original message
          }
        }
        return error
      },
    ],
  },
})

// Projects

export async function getProjects(options?: { favorite?: boolean; includeHidden?: boolean }): Promise<Project[]> {
  // Be defensive about server response shape
  // Prefer array; fallback to `{ projects: [...] }`; otherwise return empty array
  const searchParams = new URLSearchParams()
  if (options?.favorite) searchParams.set('favorite', 'true')
  if (options?.includeHidden) searchParams.set('includeHidden', 'true')
  const res = await client.get('projects', { searchParams }).json<any>()
  if (Array.isArray(res)) return res as Project[]
  if (res && Array.isArray(res.projects)) return res.projects as Project[]
  return []
}

export async function createProject(data: {
  handle: string
  name: string
  display_name?: string
  description?: string | null
  path?: string | null
}): Promise<Project> {
  return client.post('projects', { json: data }).json()
}

export async function getProject(projectId: string): Promise<Project> {
  const res = await client.get(`projects/${projectId}`).json<any>()
  return res.project || res
}

export async function updateProject(
  projectId: string,
  data: {
    name?: string
    handle?: string
    display_name?: string | null
    description?: string | null
    is_favorite?: boolean
  }
): Promise<Project> {
  return client.patch(`projects/${projectId}`, { json: data }).json()
}

export async function deleteProject(projectId: string): Promise<void> {
  await client.delete(`projects/${projectId}`)
}

export async function getSessionContext(projectId: string): Promise<SessionContext> {
  return client.get(`projects/${projectId}/session-context`).json()
}

export async function getGraphHealth(projectId: string): Promise<GraphHealth | null> {
  try {
    const res = await client.get(`projects/${projectId}/graph-health`, { throwHttpErrors: false })
    if (!res.ok) {
      const details = await res.text().catch(() => '')
      console.warn('Graph health request failed', {
        status: res.status,
        statusText: res.statusText,
        body: details,
      })
      return null
    }
    return res.json()
  } catch (error) {
    console.warn('Graph health request errored', error)
    return null
  }
}

export async function getProjectMemoryTypes(
  projectId: string
): Promise<ProjectMemoryTypesResponse | null> {
  try {
    const res = await client.get(`projects/${projectId}/memory-types`, {
      throwHttpErrors: false,
    })
    if (!res.ok) {
      const details = await res.text().catch(() => '')
      console.warn('Project memory types request failed', {
        status: res.status,
        statusText: res.statusText,
        body: details,
      })
      return null
    }
    const data = await res.json<any>()
    if (data && Array.isArray(data.memory_types)) return data as ProjectMemoryTypesResponse
  } catch (error) {
    console.warn('Project memory types request errored', error)
  }
  return null
}

export async function getProjectMemoryTypeStatuses(
  projectId: string,
  type: MemoryType
): Promise<ProjectMemoryTypeStatusesResponse | null> {
  try {
    const res = await client.get(
      `projects/${projectId}/memory-types/${type}/statuses`,
      {
        throwHttpErrors: false,
      }
    )
    if (!res.ok) {
      const details = await res.text().catch(() => '')
      console.warn('Project memory type statuses request failed', {
        status: res.status,
        statusText: res.statusText,
        body: details,
      })
      return null
    }
    const data = await res.json<any>()
    if (data && Array.isArray(data.statuses)) return data as ProjectMemoryTypeStatusesResponse
  } catch (error) {
    console.warn('Project memory type statuses request errored', error)
  }
  return null
}

// Memories

export interface VectorSearchParams {
  q: string
  project_id?: string
  type?: MemoryType
  limit?: number
  compact?: boolean
}

export interface VectorSearchResponse {
  memories: Memory[]
  pagination: Pagination
}

export async function vectorSearch(params: VectorSearchParams): Promise<VectorSearchResponse> {
  const searchParams = new URLSearchParams()

  searchParams.set('q', params.q)
  if (params.project_id) searchParams.set('project_id', params.project_id)
  if (params.type) searchParams.set('type', params.type)
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params.compact !== undefined) searchParams.set('compact', String(params.compact))

  return client.get('vector/search', { searchParams }).json()
}

export async function searchMemories(params: SearchParams): Promise<SearchResponse> {
  const searchParams = new URLSearchParams()

  if (params.q) searchParams.set('q', params.q)
  if (params.project_id) searchParams.set('project_id', params.project_id)
  if (params.type) searchParams.set('type', params.type)
  if (params.tag) searchParams.set('tag', params.tag)
  if (params.handle) searchParams.set('handle', params.handle)
  if (params.status) searchParams.set('status', params.status)
  if (params.sort) searchParams.set('sort', params.sort)
  if (params.order) searchParams.set('order', params.order)
  if (params.search_mode) searchParams.set('search_mode', params.search_mode)
  if (params.compact !== undefined) searchParams.set('compact', String(params.compact))
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params.offset !== undefined) searchParams.set('offset', String(params.offset))
  if (params.created_after) searchParams.set('created_after', params.created_after)
  if (params.created_before) searchParams.set('created_before', params.created_before)
  if (params.tz) searchParams.set('tz', params.tz)
  if (params.pinned) searchParams.set('pinned', 'true')

  return client.get('memories', { searchParams }).json()
}

export async function getMemory(
  id: string,
  projectId?: string,
  options?: { comments?: boolean }
): Promise<Memory> {
  const searchParams = new URLSearchParams()
  if (options?.comments) searchParams.set('comments', 'true')

  // Use project-scoped endpoint if projectId is provided (returns tags)
  if (projectId) {
    const res = await client.get(`projects/${projectId}/memories/${id}`, { searchParams }).json<any>()
    return res.memory || res
  }
  const res = await client.get(`memories/${id}`, { searchParams }).json<any>()
  // Handle both { memory: {...} } and direct memory response
  return res.memory || res
}

export async function createMemory(
  projectId: string,
  data: {
    handle: string
    title: string
    content: string
    type: MemoryType
    parent_type?: string | null
    tags?: string[]
  }
): Promise<Memory> {
  const res: any = await client
    .post(`projects/${projectId}/memories`, { json: data })
    .json()
  // Handle both { memory: {...} } and direct memory response
  return res.memory || res
}

export async function updateMemory(
  projectId: string,
  id: string,
  data: {
    title?: string
    handle?: string
    content?: string
    type?: MemoryType
    parent_type?: string | null
    status?: MemoryStatus
    tags?: string[]
    project_id?: string
    metadata?: Record<string, string>
  },
  options?: { snapshot?: boolean }
): Promise<Memory> {
  const searchParams = new URLSearchParams()
  if (options?.snapshot) searchParams.set('snapshot', 'true')
  const url = searchParams.toString()
    ? `projects/${projectId}/memories/${id}?${searchParams}`
    : `projects/${projectId}/memories/${id}`
  return client
    .patch(url, { json: data })
    .json()
}

export async function updateMemoryStatus(
  projectId: string,
  id: string,
  status: MemoryStatus
): Promise<{ memory_id: string; status: string; updated_at: string }> {
  return client
    .put(`projects/${projectId}/memories/${id}/status`, { json: { status } })
    .json()
}

export async function setMemoryMetadataField(
  memoryId: string,
  field: string,
  value: string
): Promise<{ memory_id: string; field: string; value: string }> {
  return client
    .put(`memories/${memoryId}/metadata/${field}`, { json: { value } })
    .json()
}

export async function deleteMemoryMetadataField(
  memoryId: string,
  field: string
): Promise<void> {
  await client.delete(`memories/${memoryId}/metadata/${field}`)
}

export async function deleteMemory(projectId: string, id: string): Promise<void> {
  await client.delete(`projects/${projectId}/memories/${id}`)
}

// Relations

export async function getMemoryRelations(id: string): Promise<FlatRelation[]> {
  const res = await client.get(`memories/${id}/relations`).json<{ relations: FlatRelation[] }>()
  return res.relations || []
}

export async function getRelationTypes(): Promise<RelationTypeInfo[]> {
  const res = await client.get('relation-types').json<{ relation_types: RelationTypeInfo[] }>()
  return res.relation_types || []
}

export async function getMemoryGraph(
  id: string,
  options?: {
    depth?: number
    compact?: boolean
    max_nodes?: number
    max_edges?: number
  }
): Promise<GraphData> {
  const searchParams = new URLSearchParams()

  if (options?.depth !== undefined) searchParams.set('depth', String(options.depth))
  if (options?.compact !== undefined) searchParams.set('compact', String(options.compact))
  if (options?.max_nodes !== undefined) searchParams.set('max_nodes', String(options.max_nodes))
  if (options?.max_edges !== undefined) searchParams.set('max_edges', String(options.max_edges))

  const raw: any = await client.get(`memories/${id}/relations/graph`, { searchParams }).json()

  // Normalize edge fields: API returns source_memory_id/target_memory_id,
  // but GraphEdge expects source/target
  return {
    ...raw,
    edges: (raw.edges || []).map((e: any) => ({
      source: e.source ?? e.source_memory_id,
      target: e.target ?? e.target_memory_id,
      relation_type: e.relation_type,
    })),
  }
}

export async function searchWithinMemory(
  memoryId: string,
  q: string
): Promise<WithinMemorySearchResult> {
  return client
    .get(`memories/${memoryId}/search`, { searchParams: { q } })
    .json()
}

export async function createRelation(
  source_memory_id: string,
  target_memory_id: string,
  relation_type: ContextualRelationType
): Promise<Relation> {
  return client
    .post('relations', {
      json: { source_memory_id, target_memory_id, relation_type },
    })
    .json()
}

export async function updateRelation(
  id: string,
  relation_type: ContextualRelationType
): Promise<Relation> {
  return client
    .patch(`relations/${id}`, {
      json: { relation_type },
    })
    .json()
}

export async function deleteRelation(id: string): Promise<void> {
  await client.delete(`relations/${id}`)
}

// Comments

export async function getComments(
  memoryId: string,
  params?: {
    order?: 'asc' | 'desc'
    status?: CommentStatus
    limit?: number
    offset?: number
  }
): Promise<CommentsResponse> {
  const searchParams = new URLSearchParams()
  if (params?.order) searchParams.set('order', params.order)
  if (params?.status) searchParams.set('status', params.status)
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params?.offset !== undefined) searchParams.set('offset', String(params.offset))
  return client.get(`memories/${memoryId}/comments`, { searchParams }).json()
}

export async function createComment(
  memoryId: string,
  data: CreateCommentInput
): Promise<Comment> {
  const res = await client
    .post(`memories/${memoryId}/comments`, { json: data })
    .json<any>()
  return res.comment || res
}

export async function updateComment(
  memoryId: string,
  commentId: string,
  data: UpdateCommentInput
): Promise<Comment> {
  const res = await client
    .patch(`memories/${memoryId}/comments/${commentId}`, { json: data })
    .json<any>()
  return res.comment || res
}

export async function deleteComment(
  memoryId: string,
  commentId: string
): Promise<void> {
  await client.delete(`memories/${memoryId}/comments/${commentId}`)
}

export async function deleteResolvedComments(
  memoryId: string
): Promise<{ deleted_count: number }> {
  return client.delete(`memories/${memoryId}/comments`, {
    searchParams: { status: 'resolved' }
  }).json()
}

// Tags

export async function getTags(): Promise<Tag[]> {
  return client.get('tags').json()
}

export async function getTagMemories(name: string): Promise<Memory[]> {
  return client.get(`tags/${encodeURIComponent(name)}/memories`).json()
}

// Status metadata

// Fetch statuses for a specific memory type. Supports multiple response shapes and falls back to []
export async function getTypeStatuses(type: MemoryType): Promise<string[]> {
  try {
    const res = await client.get(`memory-types/${type}/statuses`).json<any>()
    if (Array.isArray(res)) return res as string[]
    if (res && Array.isArray(res.statuses)) return res.statuses as string[]
  } catch (_) {
    // ignore
  }
  return []
}

// Fetch a mapping of all types to their statuses, if the API supports it.
export async function getAllTypeStatuses(): Promise<Record<string, string[]>> {
  try {
    const res = await client.get('memory-types/statuses').json<any>()
    if (res && typeof res === 'object' && !Array.isArray(res)) return res as Record<string, string[]>
  } catch (_) {
    // ignore
  }
  return {}
}

// Diagram rendering

export type DiagramType = 'mermaid' | 'd2' | 'plantuml' | 'graphviz'
export type DiagramTheme = 'dark' | 'light' | 'neutral' | 'forest' | 'ocean'

export async function previewDiagram(
  type: DiagramType,
  content: string,
  theme: DiagramTheme = 'dark',
  maxWidth?: number
): Promise<{ svg: string }> {
  return client
    .post('diagram/preview', { json: { type, content, theme, maxWidth } })
    .json<{ svg: string }>()
}

// Settings

export type SettingsMetadata = {
  description: string | null
  value_type: string
}

export type SettingsResponse = {
  settings: Record<string, string>
  metadata: Record<string, SettingsMetadata>
}

export async function getSettings(): Promise<SettingsResponse> {
  return client.get('settings').json()
}

export async function updateSettings(
  settings: Record<string, string>
): Promise<SettingsResponse> {
  return client.patch('settings', { json: settings }).json()
}

export async function getSettingsRuntime(): Promise<SettingsRuntimeResponse> {
  return client.get('settings/runtime').json<SettingsRuntimeResponse>()
}

// Redis / Live Messages

export async function getLiveMessageHealth(): Promise<{ status: 'ok' | 'unavailable'; error?: string }> {
  return client.get('live-messages/health').json()
}

// Files

export type FileUploadResponse = {
  id: string
  url: string
  filename: string
  mime_type: string
  size: number
  project_id: string
  created_at: string
}

export async function uploadFile(
  projectId: string,
  file: File
): Promise<FileUploadResponse> {
  const formData = new FormData()
  formData.append('file', file)

  return client
    .post(`projects/${projectId}/files`, { body: formData })
    .json()
}

export async function deleteFile(projectId: string, fileId: string): Promise<void> {
  await client.delete(`projects/${projectId}/files/${fileId}`)
}

export type MigrateFilesResponse = {
  moved: number
  failed: number
  errors: string[]
}

export type ProjectFile = {
  id: string
  url: string
  filename: string
  mime_type: string
  size: number
  created_at: string
  exists_on_disk: boolean
}

export type ProjectFilesResponse = {
  files: ProjectFile[]
}

export async function getProjectFiles(projectId: string): Promise<ProjectFilesResponse> {
  return client.get(`projects/${projectId}/files`).json()
}

export async function cleanupFiles(projectId: string): Promise<{ removed: number }> {
  return client.post(`projects/${projectId}/files/cleanup`).json()
}

export async function migrateFiles(targetPath: string): Promise<MigrateFilesResponse> {
  return client.post('files/migrate', { json: { targetPath } }).json()
}

// ============ Backups API ============

export type BackupFile = {
  filename: string
  size: number
  size_human: string
  created_at: string
  path: string
}

export type BackupsResponse = {
  backups: BackupFile[]
  directory: string
}

export async function getBackups(): Promise<BackupsResponse> {
  return client.get('backups/db').json()
}

export async function deleteBackup(filename: string): Promise<void> {
  await client.delete(`backups/db/${encodeURIComponent(filename)}`)
}

export type CreateBackupResponse = {
  backup: BackupFile | null
  output: string
}

export async function createBackup(): Promise<CreateBackupResponse> {
  return client.post('backups/db').json()
}

export type RestoreResponse = {
  success: boolean
  restored_from: string
  safety_backup: string | null
  message: string
}

export async function restoreBackup(filename: string): Promise<RestoreResponse> {
  return client.post(`backups/db/${encodeURIComponent(filename)}/restore`, { timeout: 120000 }).json()
}

export type ArchivedSession = {
  id: string
  session_id: string
  nickname: string | null
  project_dir: string | null
  project_handle: string | null
  project_name: string | null
  assistant_handle: string
  archive_path: string
  size: number
  size_human: string
  updated_at: string | null
}

export type ArchiveLargestFile = {
  filename: string
  relative_path: string
  archive_path: string
  assistant_handle: string
  size: number
  size_human: string
  modified_at: string
  session_db_id: string | null
  session_id: string | null
  nickname: string | null
  project_handle: string | null
  project_name: string | null
}

export type ArchivedSessionsResponse = {
  sessions: ArchivedSession[]
  largest_files: ArchiveLargestFile[]
  directory: string | null
  enabled: boolean
  archive_total_files: number
  archive_total_bytes: number
  archive_total_size_human: string
}

export async function getArchivedSessions(): Promise<ArchivedSessionsResponse> {
  return client.get('backups/sessions', { retry: 0 }).json()
}

export async function revealArchivedSessionInFinder(archivePath: string): Promise<void> {
  await client.post('backups/sessions/reveal', { json: { path: archivePath } })
}

// ============ Assistants API ============

export async function getAssistants(): Promise<Assistant[]> {
  const res = await client.get('assistants').json<{ assistants: Assistant[] }>()
  return res.assistants
}

export async function getAssistant(handle: string): Promise<Assistant> {
  const res = await client.get(`assistants/${handle}`).json<{ assistant: Assistant }>()
  return res.assistant
}

export async function getAssistantConfigs(
  handle: string,
  params?: {
    scope?: string
    type?: string
  }
): Promise<AssistantConfig[]> {
  const searchParams = new URLSearchParams()
  if (params?.scope) searchParams.set('scope', params.scope)
  if (params?.type) searchParams.set('type', params.type)
  const res = await client.get(`assistants/${handle}/configs`, { searchParams }).json<{ configs: AssistantConfig[] }>()
  return res.configs
}

export async function getAssistantConfig(id: string): Promise<AssistantConfig> {
  const res = await client.get(`configs/${id}`).json<{ config: AssistantConfig }>()
  return res.config
}

export async function createAssistantConfig(
  handle: string,
  data: {
    scope: string
    type: string
    path: string
    format: string
    content: string
    auto_sync?: boolean
  }
): Promise<AssistantConfig> {
  const res = await client.post(`assistants/${handle}/configs`, { json: data }).json<{ config: AssistantConfig }>()
  return res.config
}

export async function updateAssistantConfig(
  id: string,
  data: { content?: string; notes?: string }
): Promise<AssistantConfig> {
  const res = await client.patch(`configs/${id}`, { json: data }).json<{ config: AssistantConfig }>()
  return res.config
}

export async function deleteAssistantConfig(id: string): Promise<void> {
  await client.delete(`configs/${id}`)
}

export async function getAssistantConfigSyncStatus(id: string): Promise<AssistantConfigSyncStatus> {
  return client.get(`configs/${id}/sync`).json()
}

export async function syncAssistantConfig(id: string, force?: boolean): Promise<{ success: boolean; message: string }> {
  const searchParams = force ? new URLSearchParams({ force: 'true' }) : undefined
  return client.post(`configs/${id}/sync`, { searchParams }).json()
}

export async function importAssistantConfig(id: string): Promise<AssistantConfig> {
  const res = await client.post(`configs/${id}/import`).json<{ config: AssistantConfig }>()
  return res.config
}

// Config Snapshots
export async function getConfigSnapshots(
  configId: string
): Promise<import('../types').ConfigSnapshotsResponse> {
  return client
    .get(`configs/${configId}/snapshots`)
    .json<import('../types').ConfigSnapshotsResponse>()
}

export async function getConfigSnapshot(
  configId: string,
  snapshotNumber: number
): Promise<import('../types').ConfigSnapshot> {
  const res = await client
    .get(`configs/${configId}/snapshots/${snapshotNumber}`)
    .json<import('../types').ConfigSnapshotResponse>()
  return res.snapshot
}

export async function deleteConfigSnapshot(
  configId: string,
  snapshotNumber: number
): Promise<void> {
  await client.delete(`configs/${configId}/snapshots/${snapshotNumber}`)
}

export async function createConfigSnapshot(
  configId: string
): Promise<import('../types').ConfigCreateSnapshotResponse> {
  return client
    .post(`configs/${configId}/snapshots`)
    .json<import('../types').ConfigCreateSnapshotResponse>()
}

export async function restoreConfigSnapshot(
  configId: string,
  snapshotNumber: number
): Promise<import('../types').ConfigRestoreResponse> {
  return client
    .post(`configs/${configId}/snapshots/${snapshotNumber}/restore`)
    .json<import('../types').ConfigRestoreResponse>()
}

export async function getProjectConfigs(
  projectId: string,
  params?: {
    assistant?: string
    scope?: string
    type?: string
  }
): Promise<ProjectAssistantConfig[]> {
  const searchParams = new URLSearchParams()
  if (params?.assistant) searchParams.set('assistant', params.assistant)
  if (params?.scope) searchParams.set('scope', params.scope)
  if (params?.type) searchParams.set('type', params.type)
  const res = await client.get(`projects/${projectId}/configs`, { searchParams }).json<{ configs: ProjectAssistantConfig[] }>()
  return res.configs
}

export async function createProjectConfig(
  projectId: string,
  data: {
    assistant: string
    scope: string
    type: string
    path: string
    format: string
    content: string
    auto_sync?: boolean
  }
): Promise<ProjectAssistantConfig> {
  const res = await client.post(`projects/${projectId}/configs`, { json: data }).json<{ config: ProjectAssistantConfig }>()
  return res.config
}

// Rules Sync
export interface SyncRulesResult {
  agent: 'claude' | 'codex'
  target: string
  action: 'updated' | 'created' | 'unchanged' | 'removed'
}

export interface SyncRulesResponse {
  status: 'success'
  project: string
  rulesCount: number
  results: SyncRulesResult[]
}

export async function syncProjectRules(
  projectHandle: string,
  location?: string
): Promise<SyncRulesResponse> {
  const body = location ? { location } : {}
  return client.post(`rules/sync/project/${projectHandle}`, { json: body }).json<SyncRulesResponse>()
}

// Knowledge sync
export interface SyncKnowledgeResult {
  target: string
  action: 'created' | 'updated' | 'unchanged'
}

export interface SyncKnowledgeResponse {
  status: string
  project: string
  results: SyncKnowledgeResult[]
}

export async function syncProjectKnowledge(
  projectId: string,
  location?: string
): Promise<SyncKnowledgeResponse> {
  const body = location ? { location } : {}
  return client.post(`projects/${projectId}/knowledge/sync`, { json: body }).json<SyncKnowledgeResponse>()
}

// MCP Servers
export async function getMcpServers(handle: string): Promise<McpServersResponse> {
  return client.get(`assistants/${handle}/mcp-servers`).json<McpServersResponse>()
}

export async function addMcpServer(
  handle: string,
  server: {
    name: string
    type: 'stdio' | 'http'
    command?: string
    args?: string[]
    url?: string
    env?: Record<string, string>
  }
): Promise<McpServer> {
  const res = await client.post(`assistants/${handle}/mcp-servers`, { json: server }).json<{ server: McpServer }>()
  return res.server
}

export async function removeMcpServer(handle: string, serverName: string): Promise<void> {
  await client.delete(`assistants/${handle}/mcp-servers/${serverName}`)
}

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: unknown
}

export async function getMcpServerTools(
  handle: string,
  serverName: string
): Promise<{ server: string; tools: McpToolInfo[] }> {
  return client
    .get(`assistants/${handle}/mcp-servers/${encodeURIComponent(serverName)}/tools`)
    .json<{ server: string; tools: McpToolInfo[] }>()
}

export async function getMcpServersHealth(): Promise<McpServersHealthResponse> {
  return client.get('mcp-servers/health').json<McpServersHealthResponse>()
}

// Notifications
export type NotificationSeverity = 'info' | 'warning' | 'error'

export interface Notification {
  id: string
  kind: string
  severity: NotificationSeverity
  title: string
  body?: string
  dismissible: boolean
  created_at: string
  updated_at: string
  dismissed: boolean
  meta?: Record<string, unknown>
}

export async function getNotifications(): Promise<{ notifications: Notification[] }> {
  return client.get('notifications').json<{ notifications: Notification[] }>()
}

export async function dismissNotification(id: string): Promise<void> {
  await client.post(`notifications/${encodeURIComponent(id)}/dismiss`)
}

// User Agents (~/.claude/agents/)
export async function getAgents(handle: string): Promise<AgentConfig> {
  return client.get(`assistants/${handle}/agents`).json<AgentConfig>()
}

export async function getAgent(handle: string, name: string): Promise<Agent> {
  const res = await client.get(`assistants/${handle}/agents/${encodeURIComponent(name)}`).json<{ agent: Agent }>()
  return res.agent
}

export async function createAgent(
  handle: string,
  agent: {
    name: string
    description: string
    model?: AgentModel
    tools?: string[]
    disallowedTools?: string[]
    permissionMode?: AgentPermissionMode
    skills?: string[]
    prompt: string
  }
): Promise<Agent> {
  const res = await client.post(`assistants/${handle}/agents`, { json: agent }).json<{ agent: Agent }>()
  return res.agent
}

export async function updateAgent(
  handle: string,
  name: string,
  updates: Partial<{
    name: string
    description: string
    model: AgentModel
    tools: string[]
    disallowedTools: string[]
    permissionMode: AgentPermissionMode
    skills: string[]
    prompt: string
  }>
): Promise<Agent> {
  const res = await client.patch(`assistants/${handle}/agents/${encodeURIComponent(name)}`, { json: updates }).json<{ agent: Agent }>()
  return res.agent
}

export async function deleteAgent(handle: string, name: string): Promise<void> {
  await client.delete(`assistants/${handle}/agents/${encodeURIComponent(name)}`)
}

// Project Agents (.claude/agents/ in project directory)
export async function getProjectAgents(handle: string, projectId: string): Promise<AgentConfig> {
  return client.get(`assistants/${handle}/agents/project/${encodeURIComponent(projectId)}`).json<AgentConfig>()
}

export async function getProjectAgent(handle: string, projectId: string, name: string): Promise<Agent> {
  const res = await client.get(`assistants/${handle}/agents/project/${encodeURIComponent(projectId)}/${encodeURIComponent(name)}`).json<{ agent: Agent }>()
  return res.agent
}

export async function createProjectAgent(
  handle: string,
  projectId: string,
  agent: {
    name: string
    description: string
    model?: AgentModel
    tools?: string[]
    disallowedTools?: string[]
    permissionMode?: AgentPermissionMode
    skills?: string[]
    prompt: string
  }
): Promise<Agent> {
  const res = await client.post(`assistants/${handle}/agents/project/${encodeURIComponent(projectId)}`, { json: agent }).json<{ agent: Agent }>()
  return res.agent
}

export async function updateProjectAgent(
  handle: string,
  projectId: string,
  name: string,
  updates: Partial<{
    name: string
    description: string
    model: AgentModel
    tools: string[]
    disallowedTools: string[]
    permissionMode: AgentPermissionMode
    skills: string[]
    prompt: string
  }>
): Promise<Agent> {
  const res = await client.patch(`assistants/${handle}/agents/project/${encodeURIComponent(projectId)}/${encodeURIComponent(name)}`, { json: updates }).json<{ agent: Agent }>()
  return res.agent
}

export async function deleteProjectAgent(handle: string, projectId: string, name: string): Promise<void> {
  await client.delete(`assistants/${handle}/agents/project/${encodeURIComponent(projectId)}/${encodeURIComponent(name)}`)
}

// ============ Commands API (slash commands / skills) ============

export async function getCommands(
  handle: string,
  params?: {
    scope?: 'user' | 'project' | 'all'
    type?: CommandType
    project?: string
  }
): Promise<CommandsResponse> {
  const searchParams = new URLSearchParams()
  if (params?.scope) searchParams.set('scope', params.scope)
  if (params?.type) searchParams.set('type', params.type)
  if (params?.project) searchParams.set('project', params.project)
  return client.get(`assistants/${handle}/commands`, { searchParams }).json()
}

export async function getCommand(
  handle: string,
  name: string,
  params: {
    scope: CommandScope
    type: CommandType
    project?: string
  }
): Promise<Command> {
  const searchParams = new URLSearchParams()
  searchParams.set('scope', params.scope)
  searchParams.set('type', params.type)
  if (params.project) searchParams.set('project', params.project)
  const res = await client.get(`assistants/${handle}/commands/${encodeURIComponent(name)}`, { searchParams }).json<{ command: Command }>()
  return res.command
}

export async function createCommand(
  handle: string,
  data: {
    name: string
    description?: string
    content: string
    scope: CommandScope
    type: CommandType
    project?: string
  }
): Promise<Command> {
  const res = await client.post(`assistants/${handle}/commands`, { json: data }).json<{ command: Command }>()
  return res.command
}

export async function updateCommand(
  handle: string,
  name: string,
  params: {
    scope: CommandScope
    type: CommandType
    project?: string
  },
  data: {
    name?: string
    description?: string
    content?: string
    expected_hash?: string
    force?: boolean
  }
): Promise<Command> {
  const searchParams = new URLSearchParams()
  searchParams.set('scope', params.scope)
  searchParams.set('type', params.type)
  if (params.project) searchParams.set('project', params.project)
  const res = await client.patch(`assistants/${handle}/commands/${encodeURIComponent(name)}`, { json: data, searchParams }).json<{ command: Command }>()
  return res.command
}

export async function deleteCommand(
  handle: string,
  name: string,
  params: {
    scope: CommandScope
    type: CommandType
    project?: string
  }
): Promise<void> {
  const searchParams = new URLSearchParams()
  searchParams.set('scope', params.scope)
  searchParams.set('type', params.type)
  if (params.project) searchParams.set('project', params.project)
  await client.delete(`assistants/${handle}/commands/${encodeURIComponent(name)}`, { searchParams })
}

export interface SyncCommandResult {
  name: string
  file_path: string
  action: 'created' | 'updated' | 'unchanged'
}

export async function syncCommands(handle: string): Promise<{ results: SyncCommandResult[] }> {
  return client.post(`assistants/${handle}/commands/sync`).json()
}

// ============ Sessions API ============

export async function getSessionProjects(
  handle: string = 'claude-code'
): Promise<SessionProjectsResponse> {
  return client.get(`assistants/${encodeURIComponent(handle)}/sessions`).json()
}

export async function getProjectSessions(
  handle: string = 'claude-code',
  projectDir: string,
  params?: { sort?: string; order?: string; limit?: number; offset?: number; q?: string }
): Promise<SessionListResponse> {
  const searchParams = new URLSearchParams()
  if (params?.sort) searchParams.set('sort', params.sort)
  if (params?.order) searchParams.set('order', params.order)
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params?.offset !== undefined) searchParams.set('offset', String(params.offset))
  if (params?.q) searchParams.set('q', params.q)
  return client
    .get(`assistants/${encodeURIComponent(handle)}/sessions/${encodeURIComponent(projectDir)}`, { searchParams })
    .json()
}

export async function getSessionIds(
  handle: string = 'claude-code',
  projectDir: string,
  params?: { sort?: string; order?: string }
): Promise<{ ids: string[] }> {
  const searchParams = new URLSearchParams()
  searchParams.set('ids_only', 'true')
  if (params?.sort) searchParams.set('sort', params.sort)
  if (params?.order) searchParams.set('order', params.order)
  return client
    .get(`assistants/${encodeURIComponent(handle)}/sessions/${encodeURIComponent(projectDir)}`, { searchParams })
    .json()
}

export async function getSessionTranscript(
  handle: string = 'claude-code',
  projectDir: string,
  sessionId: string,
  params?: { limit?: number; offset?: number }
): Promise<SessionFileDetailResponse> {
  const searchParams = new URLSearchParams()
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params?.offset !== undefined) searchParams.set('offset', String(params.offset))
  return client
    .get(
      `assistants/${encodeURIComponent(handle)}/sessions/${encodeURIComponent(projectDir)}/${encodeURIComponent(sessionId)}`,
      { searchParams }
    )
    .json()
}

// Read a synced session's raw transcript by id (DB row id or file UUID). Works
// for both Claude and Codex — the API resolves file_path from the sessions row.
export async function getSessionRaw(
  sessionId: string,
  params?: { limit?: number; offset?: number }
): Promise<SessionFileDetailResponse> {
  const searchParams = new URLSearchParams()
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params?.offset !== undefined) searchParams.set('offset', String(params.offset))
  return client
    .get(`sessions/${encodeURIComponent(sessionId)}/raw`, { searchParams })
    .json()
}

export async function deleteSession(
  handle: string = 'claude-code',
  projectDir: string,
  sessionId: string
): Promise<void> {
  await client.delete(
    `assistants/${encodeURIComponent(handle)}/sessions/${encodeURIComponent(projectDir)}/${encodeURIComponent(sessionId)}`
  )
}

export async function bulkDeleteSessions(
  handle: string = 'claude-code',
  params: { projectDir?: string; before?: string; sessionIds?: string[] }
): Promise<BulkDeleteResponse> {
  return client
    .post(`assistants/${encodeURIComponent(handle)}/sessions/bulk-delete`, { json: params })
    .json()
}

// ============ Active Sessions API ============

export async function scanActiveSessions(): Promise<ActiveSessionsResponse> {
  return client.post('active-sessions/scan').json()
}

export async function terminateActiveSession(sessionId: string): Promise<{ terminated: boolean; pid: number }> {
  return client.post(`active-sessions/${encodeURIComponent(sessionId)}/terminate`).json()
}

export async function deactivateActiveSession(sessionId: string): Promise<void> {
  await client.post(`active-sessions/${encodeURIComponent(sessionId)}/deactivate`)
}

export async function sendLiveMessage(sessionId: string, content: string, fromSessionId = 'khef-ui'): Promise<{ messages: unknown[]; recipients: number }> {
  return client.post(`live-messages/${encodeURIComponent(sessionId)}`, {
    json: { from_session_id: fromSessionId, content },
  }).json()
}

export async function triggerSessionSync(opts?: { force?: boolean }): Promise<unknown> {
  const searchParams = new URLSearchParams()
  if (opts?.force) searchParams.set('force', 'true')
  return client.post('sessions/sync', { searchParams }).json()
}

export interface SessionLineageTokenCount {
  nickname: string
  total_bytes: number
  estimated_tokens: number
  session_count: number
  summary_count: number
  compaction_count: number
}

export async function getSessionLineageTokenCount(nickname: string): Promise<SessionLineageTokenCount> {
  return client.get(`sessions/by-nickname/${encodeURIComponent(nickname)}/token-count`).json()
}

// Session Teams
export interface SessionTeam {
  id: string
  name: string
  description: string | null
  project_id: string | null
  project_handle?: string | null
  project_name?: string | null
  member_count?: number
  active_count?: number
  created_at: string
  updated_at: string
}

export interface SessionTeamMember {
  session_id: string
  db_id: string | null
  nickname: string | null
  status: string | null
  summary: string | null
  message_count: number | null
  started_at: string | null
  ended_at: string | null
  model: string | null
  context_window_tokens: number | null
  last_seen_at: string | null
  project_handle: string | null
  added_at: string
  resumable: boolean
  file_path: string | null
}

export async function getSessionTeams(project?: string): Promise<{ teams: SessionTeam[] }> {
  const searchParams = new URLSearchParams()
  if (project) searchParams.set('project', project)
  return client.get('session-teams', { searchParams }).json()
}

export async function getSessionTeam(teamId: string): Promise<{ team: SessionTeam; members: SessionTeamMember[] }> {
  return client.get(`session-teams/${teamId}`).json()
}

export async function createSessionTeam(data: { name: string; description?: string; project?: string }): Promise<{ team: SessionTeam }> {
  return client.post('session-teams', { json: data }).json()
}

export async function updateSessionTeam(teamId: string, data: { name?: string; description?: string }): Promise<{ team: SessionTeam }> {
  return client.patch(`session-teams/${teamId}`, { json: data }).json()
}

export async function deleteSessionTeam(teamId: string): Promise<void> {
  await client.delete(`session-teams/${teamId}`)
}

export async function addTeamMembers(teamId: string, sessionIds: string[]): Promise<{ added: number }> {
  return client.post(`session-teams/${teamId}/members`, { json: { session_ids: sessionIds } }).json()
}

export async function removeTeamMember(teamId: string, sessionId: string): Promise<void> {
  await client.delete(`session-teams/${teamId}/members/${encodeURIComponent(sessionId)}`)
}

export async function reorderTeamMembers(teamId: string, sessionIds: string[]): Promise<void> {
  await client.patch(`session-teams/${teamId}/reorder`, { json: { session_ids: sessionIds } }).json()
}

export async function broadcastToTeam(teamId: string, content: string, fromSessionId = 'khef-ui'): Promise<{ messages: unknown[]; recipients: number }> {
  return client.post(`session-teams/${teamId}/broadcast`, { json: { content, from_session_id: fromSessionId } }).json()
}

export async function getActiveSessions(params?: {
  assistant?: string
  project_id?: string
  status?: string
}): Promise<ActiveSessionsResponse> {
  const searchParams = new URLSearchParams()
  if (params?.assistant) searchParams.set('assistant', params.assistant)
  if (params?.project_id) searchParams.set('project_id', params.project_id)
  if (params?.status) searchParams.set('status', params.status)
  return client.get('active-sessions', { searchParams }).json()
}

// ============ Session Search API ============

// List sessions with optional filters
export async function getSessions(params: {
  assistant?: string
  project?: string
  q?: string
  nickname?: string
  session_id?: string
  limit?: number
  offset?: number
  sort?: 'started_at' | 'ended_at' | 'updated_at' | 'file_size'
  order?: 'asc' | 'desc'
} = {}): Promise<SessionsResponse> {
  const searchParams = new URLSearchParams()
  if (params.assistant) searchParams.set('assistant', params.assistant)
  if (params.project) searchParams.set('project', params.project)
  if (params.q) searchParams.set('q', params.q)
  if (params.nickname) searchParams.set('nickname', params.nickname)
  if (params.session_id) searchParams.set('session_id', params.session_id)
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params.offset !== undefined) searchParams.set('offset', String(params.offset))
  if (params.sort) searchParams.set('sort', params.sort)
  if (params.order) searchParams.set('order', params.order)
  return client.get('sessions', { searchParams }).json()
}

// Backward-compat alias
export const getSyncedSessions = getSessions

export interface SessionCount {
  assistant_handle: string
  assistant_name: string
  total: number
  active: number
}

export async function getSessionCounts(): Promise<{ counts: SessionCount[] }> {
  return client.get('sessions/counts').json()
}

// Get session by database ID with chunks
export async function getSession(id: string, includeChunks = true): Promise<SessionDetailResponse> {
  const searchParams = new URLSearchParams()
  if (includeChunks) searchParams.set('include_chunks', 'true')
  return client.get(`sessions/${encodeURIComponent(id)}`, { searchParams }).json()
}

// Backward-compat alias
export const getSyncedSession = getSession

// Search sessions via PostgreSQL full-text search (new backend)
export async function searchSessionsKeyword(params: {
  q: string
  assistant?: string
  project?: string
  limit?: number
}): Promise<SessionKeywordSearchResponse> {
  const searchParams = new URLSearchParams()
  searchParams.set('q', params.q)
  if (params.assistant) searchParams.set('assistant', params.assistant)
  if (params.project) searchParams.set('project', params.project)
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit))
  return client.get('sessions/search', { searchParams }).json()
}

// Search sessions via ChromaDB embeddings (existing)
export async function searchSessions(
  handle: string = 'claude-code',
  params: {
    q: string
    mode?: 'keyword' | 'semantic'
    projectDir?: string
    limit?: number
    includeThinking?: boolean
  }
): Promise<SessionSearchResponse> {
  const searchParams = new URLSearchParams()
  searchParams.set('q', params.q)
  if (params.mode) searchParams.set('mode', params.mode)
  if (params.projectDir) searchParams.set('projectDir', params.projectDir)
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params.includeThinking !== undefined) searchParams.set('includeThinking', String(params.includeThinking))
  return client
    .get(`assistants/${encodeURIComponent(handle)}/sessions/search`, { searchParams })
    .json()
}

export async function getSessionSyncStatus(
  handle: string = 'claude-code',
  projectDir?: string
): Promise<SessionSyncStatus> {
  const searchParams = new URLSearchParams()
  if (projectDir) searchParams.set('projectDir', projectDir)
  return client
    .get(`assistants/${encodeURIComponent(handle)}/sessions/sync-embeddings/status`, { searchParams })
    .json()
}

export async function syncSessionEmbeddings(
  handle: string = 'claude-code',
  params?: { projectDir?: string; force?: boolean }
): Promise<SessionSyncResult> {
  const searchParams = new URLSearchParams()
  if (params?.projectDir) searchParams.set('projectDir', params.projectDir)
  if (params?.force !== undefined) searchParams.set('force', String(params.force))
  return client
    .post(`assistants/${encodeURIComponent(handle)}/sessions/sync-embeddings`, { searchParams })
    .json()
}

// ============ Plans API ============

export async function getPlans(
  handle: string = 'claude-code',
  params?: { sort?: 'date' | 'name'; order?: 'asc' | 'desc'; limit?: number; offset?: number }
): Promise<import('../types').PlansResponse & { pagination: Pagination }> {
  const searchParams = new URLSearchParams()
  if (params?.sort) searchParams.set('sort', params.sort)
  if (params?.order) searchParams.set('order', params.order)
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params?.offset !== undefined) searchParams.set('offset', String(params.offset))
  return client
    .get(`assistants/${encodeURIComponent(handle)}/plans`, { searchParams })
    .json()
}

export async function getPlan(
  handle: string = 'claude-code',
  filename: string
): Promise<import('../types').Plan> {
  const response: import('../types').PlanResponse = await client
    .get(`assistants/${encodeURIComponent(handle)}/plans/${encodeURIComponent(filename)}`)
    .json()
  return response.plan
}

export async function deletePlan(
  handle: string = 'claude-code',
  filename: string
): Promise<void> {
  await client.delete(
    `assistants/${encodeURIComponent(handle)}/plans/${encodeURIComponent(filename)}`
  )
}

// Plan Versions
export async function getPlanVersions(
  handle: string = 'claude-code',
  filename: string
): Promise<import('../types').PlanVersion[]> {
  const response: import('../types').PlanVersionsResponse = await client
    .get(`assistants/${encodeURIComponent(handle)}/plans/${encodeURIComponent(filename)}/versions`)
    .json()
  return response.versions
}

export async function getPlanVersion(
  handle: string = 'claude-code',
  filename: string,
  version: number
): Promise<import('../types').PlanVersion> {
  const response: import('../types').PlanVersionResponse = await client
    .get(`assistants/${encodeURIComponent(handle)}/plans/${encodeURIComponent(filename)}/versions/${version}`)
    .json()
  return response.version
}

export async function deletePlanVersion(
  handle: string = 'claude-code',
  filename: string,
  version: number
): Promise<void> {
  await client.delete(
    `assistants/${encodeURIComponent(handle)}/plans/${encodeURIComponent(filename)}/versions/${version}`
  )
}

// Plan Comments (use plan UUID, not filename)
export async function getPlanComments(
  planId: string,
  params?: {
    order?: 'asc' | 'desc'
    status?: CommentStatus
    limit?: number
    offset?: number
  }
): Promise<CommentsResponse> {
  const searchParams = new URLSearchParams()
  if (params?.order) searchParams.set('order', params.order)
  if (params?.status) searchParams.set('status', params.status)
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params?.offset !== undefined) searchParams.set('offset', String(params.offset))
  return client
    .get(`plans/${planId}/comments`, { searchParams })
    .json()
}

export async function createPlanComment(
  planId: string,
  data: CreateCommentInput
): Promise<Comment> {
  const res = await client
    .post(`plans/${planId}/comments`, { json: data })
    .json<any>()
  return res.comment || res
}

export async function updatePlanComment(
  planId: string,
  commentId: string,
  data: UpdateCommentInput
): Promise<Comment> {
  const res = await client
    .patch(`plans/${planId}/comments/${commentId}`, { json: data })
    .json<any>()
  return res.comment || res
}

export async function deletePlanComment(
  planId: string,
  commentId: string
): Promise<void> {
  await client.delete(`plans/${planId}/comments/${commentId}`)
}

export async function deletePlanResolvedComments(
  planId: string
): Promise<{ deleted_count: number }> {
  return client.delete(`plans/${planId}/comments`, {
    searchParams: { status: 'resolved' }
  }).json()
}

// Plan Export
export async function exportPlan(
  planId: string,
  format: 'markdown' | 'slack' | 'docx'
): Promise<{ blob: Blob; filename: string } | { text: string }> {
  const params = new URLSearchParams({ format })
  const url = `${API_BASE}/plans/${planId}/export?${params}`
  const response = await fetch(url)

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error || `Export failed: ${response.status}`)
  }

  if (format === 'docx') {
    const blob = await response.blob()
    const disposition = response.headers.get('Content-Disposition') || ''
    const match = disposition.match(/filename="(.+?)"/)
    const filename = match?.[1] || 'export.docx'
    return { blob, filename }
  }

  const data = await response.json()
  return { text: data.text }
}

// ============ Git/Diff API ============

export async function getCommits(
  projectId: string,
  params?: { limit?: number; offset?: number }
): Promise<CommitsResponse> {
  const searchParams = new URLSearchParams()
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params?.offset !== undefined) searchParams.set('offset', String(params.offset))
  return client
    .get(`projects/${projectId}/git/commits`, { searchParams })
    .json()
}

export interface WorkingTreeDiff {
  staged: string
  unstaged: string
  combined: string
  untracked: string
  untrackedFiles: string[]
}

export async function getCommitDiff(
  projectId: string,
  sha: string | null,
  branch: string
): Promise<{ content: string; workingTree?: WorkingTreeDiff; files: import('../types').DiffFile[] }> {
  const searchParams = new URLSearchParams()
  if (sha) {
    searchParams.set('commit_sha', sha)
  }
  searchParams.set('branch', branch)
  const res = await client
    .get(`projects/${projectId}/git/diff`, { searchParams, cache: 'no-store' })
    .json<any>()

  // For commits: { diff: string, stats: {...} }
  // For uncommitted: { staged: {...}, unstaged: {...}, combined: {...}, untracked: { diff, stats, files } }
  if (sha) {
    return {
      content: res.diff || '',
      files: [],
    }
  } else {
    return {
      content: res.combined?.diff || '',
      workingTree: {
        staged: res.staged?.diff || '',
        unstaged: res.unstaged?.diff || '',
        combined: res.combined?.diff || '',
        untracked: res.untracked?.diff || '',
        untrackedFiles: res.untracked?.files || [],
      },
      files: [],
    }
  }
}

export async function getUncommittedDiff(
  projectId: string,
  branch: string
): Promise<{ content: string; files: import('../types').DiffFile[]; hasChanges: boolean }> {
  const searchParams = new URLSearchParams()
  searchParams.set('branch', branch)
  // Don't set commit_sha to get uncommitted changes
  const res = await client
    .get(`projects/${projectId}/git/diff`, { searchParams, cache: 'no-store' })
    .json<any>()

  // New response: { staged: {...}, unstaged: {...}, combined: { diff: string, stats: {...} } }
  const content = res.combined?.diff || ''
  return {
    content,
    files: [],
    hasChanges: content.trim().length > 0,
  }
}

export interface BranchDiffResponse {
  diff: string
  stats: { files: number; insertions: number; deletions: number }
  refs: {
    branch: string
    base: string
    merge_base: string
    commit_sha: string
  }
  commits: import('../types').Commit[]
  truncated?: {
    reason: 'size' | 'files'
    limit: number
    total: number
  }
}

export async function getBranchDiff(
  projectId: string,
  base: string,
  path?: string
): Promise<BranchDiffResponse> {
  const searchParams = new URLSearchParams()
  searchParams.set('base', base)
  if (path) searchParams.set('path', path)
  return client
    .get(`projects/${projectId}/git/diff`, { searchParams, cache: 'no-store' })
    .json<BranchDiffResponse>()
}

export async function getGitBranches(
  projectId: string
): Promise<{ branches: string[]; current: string; default: string | null }> {
  return client
    .get(`projects/${projectId}/git/branches`)
    .json<{ branches: string[]; current: string; default: string | null }>()
}

export async function checkoutBranch(
  projectId: string,
  branch: string
): Promise<{ current: string }> {
  return client
    .post(`projects/${projectId}/git/checkout`, { json: { branch } })
    .json<{ current: string }>()
}

export async function createDiff(
  projectId: string,
  data: { commit_sha: string | null; branch: string }
): Promise<Diff> {
  const res = await client
    .post(`projects/${projectId}/diffs`, { json: data })
    .json<any>()
  return res.diff || res
}

export async function getDiff(diffId: string): Promise<Diff> {
  const res = await client
    .get(`diffs/${diffId}`)
    .json<any>()
  return res.diff || res
}

export async function getDiffComments(
  diffId: string,
  params?: {
    order?: 'asc' | 'desc'
    status?: CommentStatus
    limit?: number
    offset?: number
  }
): Promise<DiffCommentsResponse> {
  const searchParams = new URLSearchParams()
  if (params?.order) searchParams.set('order', params.order)
  if (params?.status) searchParams.set('status', params.status)
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params?.offset !== undefined) searchParams.set('offset', String(params.offset))
  return client.get(`diffs/${diffId}/comments`, { searchParams }).json()
}

export async function createDiffComment(
  diffId: string,
  data: CreateDiffCommentInput
): Promise<DiffComment> {
  const res = await client
    .post(`diffs/${diffId}/comments`, { json: data })
    .json<any>()
  return res.comment || res
}

export interface CreateDiffCommentByRefInput extends CreateDiffCommentInput {
  branch: string
}

export interface CreateDiffCommentByRefResponse {
  comment: DiffComment
  diff: Diff
}

/**
 * Get a diff by ref (commit SHA or 'working').
 * Returns null if no diff record exists for this ref.
 */
export async function getDiffByRef(
  projectId: string,
  ref: string
): Promise<Diff | null> {
  try {
    const res = await client
      .get(`projects/${projectId}/diffs/by-ref/${ref}`)
      .json<any>()
    return res.diff || res
  } catch (err: any) {
    // 404 means no diff exists yet
    if (err.response?.status === 404) return null
    throw err
  }
}

/**
 * Create a comment on a diff by ref (commit SHA or 'working').
 * This endpoint finds or creates the diff record automatically.
 */
export async function createDiffCommentByRef(
  projectId: string,
  ref: string,
  data: CreateDiffCommentByRefInput
): Promise<CreateDiffCommentByRefResponse> {
  const res = await client
    .post(`projects/${projectId}/diffs/by-ref/${ref}/comments`, { json: data })
    .json<any>()
  return {
    comment: res.comment,
    diff: res.diff,
  }
}

export async function updateDiffComment(
  diffId: string,
  commentId: string,
  data: UpdateDiffCommentInput
): Promise<DiffComment> {
  const res = await client
    .patch(`diffs/${diffId}/comments/${commentId}`, { json: data })
    .json<any>()
  return res.comment || res
}

export async function deleteDiffComment(
  diffId: string,
  commentId: string
): Promise<void> {
  await client.delete(`diffs/${diffId}/comments/${commentId}`)
}

export async function deleteDiffResolvedComments(
  diffId: string
): Promise<{ deleted_count: number }> {
  return client.delete(`diffs/${diffId}/comments`, {
    searchParams: { status: 'resolved' }
  }).json()
}

// Project Plans
export async function getProjectPlans(
  projectId: string,
  params?: { limit?: number; offset?: number }
): Promise<import('../types').PlansResponse & { pagination: Pagination }> {
  const searchParams = new URLSearchParams()
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params?.offset !== undefined) searchParams.set('offset', String(params.offset))
  return client
    .get(`projects/${projectId}/plans`, { searchParams })
    .json()
}

export async function updatePlanProject(
  handle: string = 'claude-code',
  filename: string,
  projectId: string | null
): Promise<import('../types').Plan> {
  const response: import('../types').PlanResponse = await client
    .patch(`assistants/${encodeURIComponent(handle)}/plans/${encodeURIComponent(filename)}`, {
      json: { project_id: projectId },
    })
    .json()
  return response.plan
}

// ============ Memory Files API (auto-memory) ============

export async function getMemoryProjects(
  handle: string = 'claude-code'
): Promise<import('../types').MemoryProjectsResponse> {
  return client.get(`assistants/${encodeURIComponent(handle)}/memories`).json()
}

export async function getMemoryFiles(
  handle: string = 'claude-code',
  projectDir: string
): Promise<import('../types').MemoryFilesResponse> {
  return client
    .get(`assistants/${encodeURIComponent(handle)}/memories/${encodeURIComponent(projectDir)}`)
    .json()
}

export async function getMemoryFile(
  handle: string = 'claude-code',
  projectDir: string,
  filename: string
): Promise<import('../types').MemoryFile> {
  const response: import('../types').MemoryFileResponse = await client
    .get(`assistants/${encodeURIComponent(handle)}/memories/${encodeURIComponent(projectDir)}/${encodeURIComponent(filename)}`)
    .json()
  return response.file
}

export async function getMemoryFileSnapshots(
  handle: string = 'claude-code',
  projectDir: string,
  filename: string
): Promise<import('../types').MemoryFileSnapshot[]> {
  const response: import('../types').MemoryFileSnapshotsResponse = await client
    .get(`assistants/${encodeURIComponent(handle)}/memories/${encodeURIComponent(projectDir)}/${encodeURIComponent(filename)}/snapshots`)
    .json()
  return response.snapshots
}

export async function createMemoryFileSnapshot(
  handle: string = 'claude-code',
  projectDir: string,
  filename: string
): Promise<{ snapshot_number: number }> {
  return client
    .post(`assistants/${encodeURIComponent(handle)}/memories/${encodeURIComponent(projectDir)}/${encodeURIComponent(filename)}/snapshots`)
    .json()
}

export async function restoreMemoryFileSnapshot(
  handle: string = 'claude-code',
  projectDir: string,
  filename: string,
  snapshotNumber: number
): Promise<{ restored_snapshot: number; new_snapshot: number }> {
  return client
    .post(`assistants/${encodeURIComponent(handle)}/memories/${encodeURIComponent(projectDir)}/${encodeURIComponent(filename)}/snapshots/${snapshotNumber}/restore`)
    .json()
}

export async function deleteMemoryFileSnapshot(
  handle: string = 'claude-code',
  projectDir: string,
  filename: string,
  snapshotNumber: number
): Promise<void> {
  await client.delete(
    `assistants/${encodeURIComponent(handle)}/memories/${encodeURIComponent(projectDir)}/${encodeURIComponent(filename)}/snapshots/${snapshotNumber}`
  )
}

export async function getMemoryFileSnapshot(
  handle: string = 'claude-code',
  projectDir: string,
  filename: string,
  snapshotNumber: number
): Promise<import('../types').MemoryFileSnapshot> {
  const response: { snapshot: import('../types').MemoryFileSnapshot } = await client
    .get(`assistants/${encodeURIComponent(handle)}/memories/${encodeURIComponent(projectDir)}/${encodeURIComponent(filename)}/snapshots/${snapshotNumber}`)
    .json()
  return response.snapshot
}

export async function updateMemoryFile(
  handle: string = 'claude-code',
  projectDir: string,
  filename: string,
  content: string
): Promise<import('../types').MemoryFile> {
  const response: import('../types').MemoryFileResponse = await client
    .put(`assistants/${encodeURIComponent(handle)}/memories/${encodeURIComponent(projectDir)}/${encodeURIComponent(filename)}`, {
      json: { content },
    })
    .json()
  return response.file
}

export async function deleteMemoryFile(
  handle: string = 'claude-code',
  projectDir: string,
  filename: string
): Promise<void> {
  await client.delete(
    `assistants/${encodeURIComponent(handle)}/memories/${encodeURIComponent(projectDir)}/${encodeURIComponent(filename)}`
  )
}

// Stats

type StatsFilters = { project?: string; since?: string; until?: string }

function statsQuery(filters?: StatsFilters): string {
  const params = new URLSearchParams()
  if (filters?.project) params.set('project', filters.project)
  if (filters?.since) params.set('since', filters.since)
  if (filters?.until) params.set('until', filters.until)
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

// Aggregate — kept for tests and the MCP get_stats tool (which reads only the
// overview fields). UI code uses the per-tab helpers below.
export async function getStats(filters?: StatsFilters): Promise<StatsResponse> {
  return client.get(`stats${statsQuery(filters)}`).json()
}

export async function getStatsOverview(filters?: StatsFilters): Promise<StatsOverviewResponse> {
  return client.get(`stats/overview${statsQuery(filters)}`).json()
}

export async function getStatsMemory(filters?: StatsFilters): Promise<StatsMemoryResponse> {
  return client.get(`stats/memory${statsQuery(filters)}`).json()
}

export async function getStatsUsage(filters?: StatsFilters): Promise<StatsUsageResponse> {
  return client.get(`stats/usage${statsQuery(filters)}`).json()
}

export async function getStatsSystem(): Promise<StatsSystemResponse> {
  return client.get('stats/system').json()
}

// ============ Memory Types API ============

export interface MemoryTypeListItem {
  type: string
  description: string | null
  built_in: boolean
  memory_count: number
  is_parent_type?: boolean
  parent_type?: string
  children?: string[]
  statuses: { value: string; display_name: string | null; sort_order: number }[]
}

export interface MemoryTypeInput {
  name: string
  description?: string
  parent_type?: string
  statuses: { value: string; display_name?: string; sort_order: number }[]
}

export async function getMemoryTypes(): Promise<MemoryTypeListItem[]> {
  const res = await client.get('memory-types').json<{ memory_types: MemoryTypeListItem[] }>()
  return res.memory_types || []
}

export async function createMemoryType(data: MemoryTypeInput): Promise<MemoryTypeListItem> {
  const res = await client.post('memory-types', { json: data }).json<{ memory_type: MemoryTypeListItem }>()
  return res.memory_type
}

export async function updateMemoryType(
  name: string,
  data: Partial<MemoryTypeInput>
): Promise<MemoryTypeListItem> {
  const res = await client
    .patch(`memory-types/${encodeURIComponent(name)}`, { json: data })
    .json<{ memory_type: MemoryTypeListItem }>()
  return res.memory_type
}

export async function deleteMemoryType(name: string): Promise<void> {
  await client.delete(`memory-types/${encodeURIComponent(name)}`)
}

// --- Memory Export ---

export type ExportFormat = 'markdown' | 'docx' | 'slack' | 'csv' | 'xlsx' | 'html'

export interface ExportOptions {
  diagramTheme?: import('./exportPreferences').DiagramTheme
  diagramScale?: import('./exportPreferences').DiagramScale
  // Playwright-based rendering options
  imageQuality?: import('./exportPreferences').ImageQuality
  displaySize?: number // 10-300 percent
}

export async function exportMemory(
  memoryId: string,
  format: ExportFormat,
  options?: ExportOptions
): Promise<{ blob: Blob; filename: string } | { text: string }> {
  const params = new URLSearchParams({ format })
  if (options?.diagramTheme) {
    params.set('diagramTheme', options.diagramTheme)
  }
  if (options?.diagramScale) {
    params.set('diagramScale', String(options.diagramScale))
  }
  if (options?.imageQuality) {
    params.set('pngRenderScale', String(options.imageQuality))
  }
  if (options?.displaySize) {
    params.set('pngDisplayScalePercent', String(options.displaySize))
  }
  const url = `${API_BASE}/memories/${memoryId}/export?${params}`
  const response = await fetch(url)

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error || `Export failed: ${response.status}`)
  }

  if (format === 'docx' || format === 'xlsx') {
    const blob = await response.blob()
    const disposition = response.headers.get('Content-Disposition') || ''
    const match = disposition.match(/filename="(.+?)"/)
    const ext = format === 'xlsx' ? 'xlsx' : 'docx'
    const filename = match?.[1] || `export.${ext}`
    return { blob, filename }
  }

  // markdown, slack, and csv return text
  return { text: await response.text() }
}

// ============ XLSX to CSV Conversion ============

export async function convertXlsxToCsv(xlsxBase64: string): Promise<string> {
  const res = await client.post('memories/convert/xlsx-to-csv', {
    json: { data: xlsxBase64 },
  }).json<{ csv: string }>()
  return res.csv
}

// ============ Save to Drive ============

export type DriveFormat = 'markdown' | 'docx' | 'csv' | 'xlsx' | 'html'

export async function saveMemoryToDrive(
  memoryId: string,
  format: DriveFormat = 'markdown',
  options?: ExportOptions
): Promise<{ filename: string; path: string }> {
  const params = new URLSearchParams({ format })
  const body: Record<string, unknown> = {}
  if (options?.diagramTheme) body.diagramTheme = options.diagramTheme
  if (options?.diagramScale) body.diagramScale = options.diagramScale
  if (options?.imageQuality) body.pngRenderScale = options.imageQuality
  if (options?.displaySize) body.pngDisplayScalePercent = options.displaySize
  const res = await client.post(`memories/${memoryId}/save-to-drive?${params}`, { json: body }).json<{ filename: string; path: string }>()
  return res
}

// ============ Memory Snapshots API ============

export interface MemorySnapshotListItem {
  id: string
  snapshot_number: number
  content_hash: string
  source: string | null
  created_at: string
  is_current: boolean
  has_comments: boolean
  content_size: number
  comment_count: number
}

export interface MemorySnapshotsResponse {
  memory_id: string
  current_snapshot: number
  snapshots: MemorySnapshotListItem[]
  total: number
}

export interface MemorySnapshotDetail {
  memory_id: string
  snapshot_number: number
  content: string
  content_hash?: string
  source?: string
  created_at?: string
  is_current: boolean
  comments: Comment[]
}

export async function getMemorySnapshots(memoryId: string): Promise<MemorySnapshotsResponse> {
  return client.get(`memories/${memoryId}/snapshots`).json()
}

export async function getMemorySnapshot(
  memoryId: string,
  snapshotNumber: number
): Promise<MemorySnapshotDetail> {
  return client.get(`memories/${memoryId}/snapshots/${snapshotNumber}`).json()
}

export async function deleteMemorySnapshot(
  memoryId: string,
  snapshotNumber: number
): Promise<{
  deleted_snapshot: number
  new_current_snapshot?: number
  current_snapshot?: number
  message: string
}> {
  return client.delete(`memories/${memoryId}/snapshots/${snapshotNumber}`).json()
}

export async function bulkDeleteMemorySnapshots(
  memoryId: string,
  snapshotNumbers: number[]
): Promise<{
  deleted: number[]
  not_found?: number[]
  current_snapshot: number
  message: string
}> {
  return client
    .post(`memories/${memoryId}/snapshots/bulk-delete`, {
      json: { snapshot_numbers: snapshotNumbers },
    })
    .json()
}

export async function restoreMemorySnapshot(
  memoryId: string,
  snapshotNumber: number,
  options?: { skip_snapshot?: boolean }
): Promise<{
  restored_snapshot?: number
  current_snapshot?: number
  message?: string
}> {
  return client.post(`memories/${memoryId}/snapshots/${snapshotNumber}/restore`, {
    json: options,
  }).json()
}

export interface SnapshotDiffChange {
  type: 'add' | 'remove' | 'equal' | 'skip'
  value: string
  lines_skipped?: number
}

export interface SnapshotDiffResponse {
  memory_id: string
  from: { snapshot_number: number; source: string | null; created_at: string }
  to: { snapshot_number: number; source: string | null; created_at: string }
  changes: SnapshotDiffChange[]
  stats: { additions: number; deletions: number; unchanged: number }
}

export async function getMemorySnapshotDiff(
  memoryId: string,
  from: number | 'current',
  to: number | 'current',
  context?: number
): Promise<SnapshotDiffResponse> {
  const searchParams: Record<string, string> = { from: String(from), to: String(to), limit: '0' }
  if (context !== undefined) searchParams.context = String(context)
  return client
    .get(`memories/${memoryId}/snapshots/diff`, { searchParams })
    .json()
}

// ============ Google Integration API ============

export async function getGoogleStatus(): Promise<GoogleStatus> {
  return client.get('google/status').json()
}

export async function getGcloudAccounts(): Promise<GcloudAccountsResponse> {
  return client.get('gcloud/accounts').json()
}

export async function getGcloudHealth(): Promise<GcloudHealthResponse> {
  return client.get('gcloud/health').json()
}

export async function setGcloudAccount(account: string): Promise<GcloudSetAccountResponse> {
  return client.post('gcloud/account', { json: { account } }).json()
}

export async function getGoogleDoc(
  docId: string,
  includeComments = true
): Promise<GoogleDocContent> {
  const searchParams = new URLSearchParams()
  searchParams.set('includeComments', String(includeComments))
  return client
    .get(`google/docs/${encodeURIComponent(docId)}`, { searchParams })
    .json()
}

export async function importGoogleDoc(
  docId: string,
  data: GoogleDocImportInput
): Promise<GoogleDocImportResponse> {
  return client
    .post(`google/docs/${encodeURIComponent(docId)}/import`, { json: data })
    .json()
}

export async function syncExternalSource(
  memoryId: string,
  mode: 'update' | 'snapshot' = 'update'
): Promise<ExternalSyncResponse> {
  const searchParams = new URLSearchParams()
  if (mode !== 'update') searchParams.set('mode', mode)
  return client
    .post(`memories/${memoryId}/sync-external`, { searchParams })
    .json()
}

// ============ Prompts API ============

export async function getPrompts(
  params?: { assistant?: string; type?: string; limit?: number; offset?: number }
): Promise<import('../types').PromptsResponse> {
  const searchParams = new URLSearchParams()
  if (params?.assistant) searchParams.set('assistant', params.assistant)
  if (params?.type) searchParams.set('type', params.type)
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params?.offset !== undefined) searchParams.set('offset', String(params.offset))
  return client.get('prompts', { searchParams }).json()
}

export async function getPrompt(id: string): Promise<import('../types').Prompt> {
  const res = await client.get(`prompts/${id}`).json<import('../types').PromptResponse>()
  return res.prompt
}

export async function createPrompt(data: {
  handle: string
  title: string
  content: string
  description?: string
  assistants?: Array<{
    assistant_handle: string
    prompt_type: string
    source_path?: string
  }>
}): Promise<import('../types').Prompt> {
  const res = await client.post('prompts', { json: data }).json<import('../types').PromptResponse>()
  return res.prompt
}

export async function updatePrompt(
  id: string,
  data: {
    title?: string
    content?: string
    description?: string
    snapshot?: boolean
  }
): Promise<import('../types').Prompt> {
  const res = await client.patch(`prompts/${id}?compact=false`, { json: data }).json<import('../types').PromptResponse>()
  return res.prompt
}

export async function deletePrompt(id: string): Promise<void> {
  await client.delete(`prompts/${id}`)
}

export async function getPromptSyncStatus(id: string): Promise<{ status: import('../types').PromptSyncStatus[] }> {
  return client.get(`prompts/${id}/sync`).json()
}

export async function syncPrompt(id: string, force?: boolean): Promise<import('../types').PromptSyncResult> {
  const searchParams = force ? new URLSearchParams({ force: 'true' }) : undefined
  return client.post(`prompts/${id}/sync`, { searchParams }).json()
}

export async function getPromptSnapshots(id: string): Promise<import('../types').PromptSnapshotsResponse> {
  return client.get(`prompts/${id}/snapshots`).json()
}

export async function getPromptSnapshot(id: string, snapshotNumber: number): Promise<import('../types').PromptSnapshot> {
  const res = await client.get(`prompts/${id}/snapshots/${snapshotNumber}`).json<{ snapshot: import('../types').PromptSnapshot }>()
  return res.snapshot
}

export async function createPromptSnapshot(id: string): Promise<import('../types').PromptSnapshot> {
  const res = await client.post(`prompts/${id}/snapshots`).json<{ snapshot: import('../types').PromptSnapshot }>()
  return res.snapshot
}

export async function deletePromptSnapshot(id: string, snapshotNumber: number): Promise<void> {
  await client.delete(`prompts/${id}/snapshots/${snapshotNumber}`)
}

export async function getPromptSnapshotDiff(
  id: string,
  from: number | 'current',
  to: number | 'current',
  context?: number
): Promise<import('../types').PromptSnapshotDiffResponse> {
  const searchParams: Record<string, string> = { from: String(from), to: String(to), limit: '0' }
  if (context !== undefined) searchParams.context = String(context)
  return client.get(`prompts/${id}/snapshots/diff`, { searchParams }).json()
}

export async function addPromptAssistant(
  id: string,
  data: { assistant_handle: string; prompt_type: string; source_path?: string }
): Promise<void> {
  await client.post(`prompts/${id}/assistants`, { json: data })
}

export async function removePromptAssistant(id: string, assistantHandle: string): Promise<void> {
  await client.delete(`prompts/${id}/assistants/${encodeURIComponent(assistantHandle)}`)
}

export async function discoverPrompts(assistantHandle?: string): Promise<import('../types').PromptDiscoverResponse> {
  const url = assistantHandle ? `prompts/discover/${encodeURIComponent(assistantHandle)}` : 'prompts/discover'
  return client.post(url).json()
}

// Gemini API

export async function getGeminiStatus(): Promise<import('../types').GeminiStatus> {
  return client.get('gemini/status').json()
}

export async function getGeminiSettings(): Promise<{ settings: import('../types').GeminiSettings }> {
  return client.get('gemini/settings').json()
}

export async function getGeminiConversations(params?: {
  project_id?: string
  limit?: number
  offset?: number
}): Promise<import('../types').GeminiConversationsResponse> {
  const searchParams = new URLSearchParams()
  if (params?.project_id) searchParams.set('project_id', params.project_id)
  if (params?.limit) searchParams.set('limit', String(params.limit))
  if (params?.offset) searchParams.set('offset', String(params.offset))
  return client.get('gemini/conversations', { searchParams }).json()
}

export async function getGeminiConversation(id: string): Promise<import('../types').GeminiConversationWithMessages> {
  const res = await client.get(`gemini/conversations/${id}`).json<import('../types').GeminiConversationResponse>()
  return res.conversation
}

export async function createGeminiConversation(data: {
  title?: string
  project_id?: string
}): Promise<import('../types').GeminiConversation> {
  const res = await client.post('gemini/conversations', { json: data }).json<{ conversation: import('../types').GeminiConversation }>()
  return res.conversation
}

export async function updateGeminiConversation(
  id: string,
  data: { title?: string; project_id?: string | null }
): Promise<import('../types').GeminiConversation> {
  const res = await client.patch(`gemini/conversations/${id}`, { json: data }).json<{ conversation: import('../types').GeminiConversation }>()
  return res.conversation
}

export async function deleteGeminiConversation(id: string): Promise<void> {
  await client.delete(`gemini/conversations/${id}`)
}

export async function deleteGeminiMessage(conversationId: string, messageId: string): Promise<void> {
  await client.delete(`gemini/conversations/${conversationId}/messages/${messageId}`)
}

export async function sendGeminiMessage(
  conversationId: string,
  data: import('../types').GeminiGenerateInput & { prompt_id?: string }
): Promise<import('../types').GeminiMessageResponse> {
  return client.post(`gemini/conversations/${conversationId}/messages`, { json: data }).json()
}

export async function generateGemini(
  data: import('../types').GeminiGenerateInput
): Promise<import('../types').GeminiGenerateResponse> {
  return client.post('gemini/generate', { json: data }).json()
}

// ============ Kdag Backends ============

export async function getKdagBackends(): Promise<{ backends: import('../types').KdagBackend[] }> {
  return client.get('kdag/backends').json()
}

// ============ Kdag Jobs API ============

export async function createKdagJob(body: {
  assistant_handle?: string
  job_type?: string
  definition_key?: string
  session_id?: string
  prompt_text?: string
  system_prompt_text?: string
  model?: string
  cli_flags?: Record<string, unknown>
  mode?: 'full' | 'incremental' | 'consolidate'
  inputs?: Record<string, string>
}): Promise<{ job: { id: string; job_type: string; definition_key?: string; created_at: string } }> {
  return client.post('kdag/job', { json: body }).json()
}

export async function runKdagJob(jobId: string, opts?: { assistant_handle?: string; model?: string; step_timeout_ms?: number }): Promise<{ status: string; job_id: string }> {
  return client.post(`kdag/job/${jobId}/run`, { json: opts || {} }).json()
}

export async function retryKdagJob(jobId: string, opts?: { assistant_handle?: string; model?: string; step_timeout_ms?: number }): Promise<{ status: string; job_id: string; run_id: string }> {
  return client.post(`kdag/job/${jobId}/retry`, { json: opts || {} }).json()
}

export async function rerunKdagJobFromStep(jobId: string, fromStep: string, opts?: { from_batch?: number; model?: string; step_timeout_ms?: number; batch_delay_ms?: number }): Promise<{ status: string; job_id: string; from_step: string }> {
  return client.post(`kdag/job/${jobId}/rerun`, { json: { from_step: fromStep, ...opts } }).json()
}

export async function getKdagJob(jobId: string, includeContent?: boolean): Promise<import('../types').KdagJobDetailResponse> {
  const searchParams: Record<string, string> = {}
  if (includeContent) searchParams.include_content = 'true'
  return client.get(`kdag/job/${jobId}`, { searchParams }).json()
}

export async function listKdagJobs(params?: {
  status?: string
  project?: string
  job_type?: string
  definition_key?: string
  sort?: string
  order?: string
  limit?: number
  offset?: number
}): Promise<import('../types').KdagJobListResponse> {
  const searchParams = new URLSearchParams()
  if (params?.status) searchParams.set('status', params.status)
  if (params?.project) searchParams.set('project', params.project)
  if (params?.job_type) searchParams.set('job_type', params.job_type)
  if (params?.definition_key) searchParams.set('definition_key', params.definition_key)
  if (params?.sort) searchParams.set('sort', params.sort)
  if (params?.order) searchParams.set('order', params.order)
  if (params?.limit) searchParams.set('limit', String(params.limit))
  if (params?.offset) searchParams.set('offset', String(params.offset))
  return client.get('kdag/jobs', { searchParams }).json()
}

export async function deleteKdagJob(jobId: string): Promise<void> {
  await client.delete(`kdag/jobs/${jobId}`)
}

export async function bulkDeleteKdagJobs(jobIds: string[]): Promise<{ deleted: number; skipped: number }> {
  return client.post('kdag/jobs/bulk-delete', { json: { job_ids: jobIds } }).json()
}

export async function cancelKdagJob(jobId: string): Promise<{ canceled: boolean; run_id: string }> {
  return client.post(`kdag/job/${jobId}/cancel`).json()
}

// ============ Job Definitions API ============

export async function listJobDefinitions(params?: {
  sort?: string
  order?: string
  limit?: number
  offset?: number
  includeHidden?: boolean
}): Promise<{ definitions: import('../types').JobDefinitionSummary[]; pagination: import('../types').Pagination }> {
  const searchParams = new URLSearchParams()
  if (params?.sort) searchParams.set('sort', params.sort)
  if (params?.order) searchParams.set('order', params.order)
  if (params?.limit != null) searchParams.set('limit', String(params.limit))
  if (params?.offset != null) searchParams.set('offset', String(params.offset))
  if (params?.includeHidden) searchParams.set('includeHidden', 'true')
  return client.get('kdag/definitions', { searchParams }).json()
}

export async function getJobDefinition(key: string): Promise<import('../types').JobDefinitionDetail> {
  return client.get(`kdag/definitions/${encodeURIComponent(key)}`).json()
}

export async function createJobDefinition(body: {
  key: string
  name: string
  description?: string
  steps: import('../types').JobDefinitionStep[]
  inputs?: import('../types').JobDefinitionInput[]
}): Promise<{ definition: { id: string; key: string; name: string } }> {
  return client.post('kdag/definitions', { json: body }).json()
}

export async function updateJobDefinition(key: string, body: {
  name?: string
  description?: string
  steps?: import('../types').JobDefinitionStep[]
  inputs?: import('../types').JobDefinitionInput[]
}): Promise<{ updated: boolean }> {
  return client.patch(`kdag/definitions/${encodeURIComponent(key)}`, { json: body }).json()
}

export async function deleteJobDefinition(key: string): Promise<void> {
  await client.delete(`kdag/definitions/${encodeURIComponent(key)}`)
}

export async function exportJobDefinition(key: string): Promise<Blob> {
  const url = `${API_BASE}/kdag/definitions/${encodeURIComponent(key)}/export`
  const response = await fetch(url, {
    headers: { Accept: 'application/zip' },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error || `Export failed: ${response.status}`)
  }
  return response.blob()
}

export async function listKdagInputTypes(): Promise<{ input_types: import('../types').KdagInputType[] }> {
  return client.get('kdag/input-types').json()
}

export async function getSessionSummary(sessionId: string): Promise<import('../types').SessionSummaryResponse> {
  return client.get(`sessions/${encodeURIComponent(sessionId)}/summary`).json()
}

export interface SessionLiveMemory {
  pid: number | null
  memory_bytes: number | null
  memory_human: string | null
}

export async function getSessionLiveMemory(sessionId: string): Promise<SessionLiveMemory> {
  return client.get(`sessions/${encodeURIComponent(sessionId)}/live-memory`).json()
}

export async function patchSession(sessionId: string, data: { summary?: string; name?: string }): Promise<{ session: { id: string; summary: string | null; name: string | null; updated_at: string } }> {
  return client.patch(`sessions/${encodeURIComponent(sessionId)}`, { json: data }).json()
}

export async function updateSessionSummary(sessionId: string, content: string): Promise<{ summary: { id: string; content: string; updated_at: string } }> {
  return client.patch(`sessions/${encodeURIComponent(sessionId)}/summary`, { json: { content } }).json()
}

export async function exportSessionSummary(sessionId: string, format: 'markdown' | 'slack', scope: 'current' | 'all' = 'current'): Promise<{ text: string }> {
  return client.get(`sessions/${encodeURIComponent(sessionId)}/summary/export`, { searchParams: { format, scope } }).json()
}

export async function getSessionSummarySnapshot(
  sessionId: string,
  snapshotId: string
): Promise<{ snapshot: { id: string; content: string; assistant_handle: string; created_at: string } }> {
  return client.get(`sessions/${encodeURIComponent(sessionId)}/summary/snapshots/${encodeURIComponent(snapshotId)}`).json()
}

export async function deleteSessionSummarySnapshot(sessionId: string, snapshotId: string): Promise<void> {
  await client.delete(`sessions/${encodeURIComponent(sessionId)}/summary/snapshots/${encodeURIComponent(snapshotId)}`)
}

export async function deleteSessionSummary(sessionId: string): Promise<void> {
  await client.delete(`sessions/${encodeURIComponent(sessionId)}/summary`)
}

// ============ kvec (Vector Collections) API ============

export async function getKvecCollections(): Promise<import('../types').KvecCollectionsResponse> {
  return client.get('kvec/collections').json()
}

export async function getKvecCollection(name: string): Promise<import('../types').KvecCollectionResponse> {
  return client.get(`kvec/collections/${encodeURIComponent(name)}`).json()
}



export async function getKvecRepos(collectionName: string): Promise<import('../types').KvecReposResponse> {
  return client.get(`kvec/collections/${encodeURIComponent(collectionName)}/repos`).json()
}

export async function getKvecDocPaths(collectionName: string): Promise<import('../types').KvecDocPathsResponse> {
  return client.get(`kvec/collections/${encodeURIComponent(collectionName)}/doc-paths`).json()
}

export async function getKvecFiles(
  collectionName: string,
  params?: { repo?: string; language?: string; status?: string; q?: string; limit?: number; offset?: number }
): Promise<import('../types').KvecFilesResponse> {
  const searchParams = new URLSearchParams()
  if (params?.repo) searchParams.set('repo', params.repo)
  if (params?.language) searchParams.set('language', params.language)
  if (params?.status) searchParams.set('status', params.status)
  if (params?.q) searchParams.set('q', params.q)
  if (params?.limit) searchParams.set('limit', String(params.limit))
  if (params?.offset) searchParams.set('offset', String(params.offset))
  return client.get(`kvec/collections/${encodeURIComponent(collectionName)}/files`, { searchParams }).json()
}

export async function deleteKvecFile(collectionName: string, fileId: string): Promise<void> {
  await client.delete(`kvec/collections/${encodeURIComponent(collectionName)}/files/${fileId}`)
}

export async function bulkDeleteKvecFiles(
  collectionName: string,
  ids: string[]
): Promise<{ deleted: number }> {
  return client
    .post(`kvec/collections/${encodeURIComponent(collectionName)}/files/bulk-delete`, { json: { ids } })
    .json()
}

export async function deleteKvecRepo(collectionName: string, repoId: string): Promise<void> {
  await client.delete(`kvec/collections/${encodeURIComponent(collectionName)}/repos/${repoId}`)
}

export async function getKvecLanguages(collectionName: string): Promise<import('../types').KvecLanguagesResponse> {
  return client.get(`kvec/collections/${encodeURIComponent(collectionName)}/languages`).json()
}

// ============ kvec Embed Jobs API ============

export async function checkEmbedHealth(): Promise<import('../types').EmbedHealth> {
  return client.get('kvec/embed/health').json()
}

export async function startEmbedJob(params: {
  path: string
  extensions?: string[]
  batchSize?: number
  batchDelayMs?: number
}): Promise<import('../types').EmbedJobResponse> {
  return client.post('kvec/embed/jobs', { json: params }).json()
}

export async function startCommitEmbedJob(params: {
  path: string
  branch?: string
  batchSize?: number
  batchDelayMs?: number
}): Promise<import('../types').EmbedJobResponse> {
  return client.post('kvec/embed/commit-jobs', { json: params }).json()
}

export async function startDocEmbedJob(params: {
  path: string
  extensions?: string[]
  project_handle?: string
  tags?: string[]
  title?: string
  batchSize?: number
  batchDelayMs?: number
}): Promise<import('../types').EmbedJobResponse> {
  return client.post('kvec/embed/doc-jobs', { json: params }).json()
}

export async function listDocEmbedJobs(): Promise<import('../types').EmbedJobsResponse> {
  return client.get('kvec/embed/doc-jobs').json()
}

export async function cancelDocEmbedJob(id: string): Promise<import('../types').EmbedJobResponse> {
  return client.post(`kvec/embed/doc-jobs/${id}/cancel`).json()
}

export async function deleteDocEmbedJob(id: string): Promise<void> {
  await client.delete(`kvec/embed/doc-jobs/${id}`)
}

export async function getEmbedGitInfo(path: string): Promise<{
  currentBranch: string
  localBranches: string[]
  remoteBranches: string[]
}> {
  return client.get('kvec/embed/git-info', { searchParams: { path } }).json()
}

export async function checkoutEmbedRepo(
  path: string,
  branch: string
): Promise<{ current: string }> {
  return client.post('kvec/embed/checkout', { json: { path, branch } }).json()
}

export async function listEmbedJobs(): Promise<import('../types').EmbedJobsResponse> {
  return client.get('kvec/embed/jobs').json()
}

export async function getEmbedJob(id: string): Promise<import('../types').EmbedJobResponse> {
  return client.get(`kvec/embed/jobs/${id}`).json()
}

export async function cancelEmbedJob(id: string): Promise<import('../types').EmbedJobResponse> {
  return client.post(`kvec/embed/jobs/${id}/cancel`).json()
}

export async function deleteEmbedJob(id: string): Promise<void> {
  await client.delete(`kvec/embed/jobs/${id}`)
}

// ============ Kvec Auto-Embed API ============

export async function getAutoEmbedConfigs(): Promise<import('../types').AutoEmbedConfigsResponse> {
  return client.get('kvec/auto-embed').json()
}

export async function createAutoEmbedConfig(params: {
  repo_path: string
  branch?: string
  job_type?: import('../types').AutoEmbedJobType
  batch_delay_ms?: number
}): Promise<import('../types').AutoEmbedConfigResponse> {
  return client.post('kvec/auto-embed', { json: params }).json()
}

export async function updateAutoEmbedConfig(id: string, params: {
  enabled?: boolean
  batch_delay_ms?: number
  branch?: string
}): Promise<import('../types').AutoEmbedConfigResponse> {
  return client.patch(`kvec/auto-embed/${id}`, { json: params }).json()
}

export async function deleteAutoEmbedConfig(id: string): Promise<void> {
  await client.delete(`kvec/auto-embed/${id}`)
}

export async function runAutoEmbedNow(): Promise<{ queued: number; checked: number; errors: number }> {
  return client.post('kvec/auto-embed/run').json()
}

// ============ Commit Search API ============

export async function searchCommits(params: {
  q: string
  repo?: string
  author?: string
  limit?: number
  offset?: number
  min_score?: number
}): Promise<import('../types').CommitSearchResponse> {
  const searchParams = new URLSearchParams()
  searchParams.set('q', params.q)
  if (params.repo) searchParams.set('repo', params.repo)
  if (params.author) searchParams.set('author', params.author)
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params.offset !== undefined) searchParams.set('offset', String(params.offset))
  if (params.min_score !== undefined) searchParams.set('min_score', String(params.min_score))
  return client.get('vector/commits/search', { searchParams }).json()
}

// ============ Slack Search API ============

export async function searchSlack(params: {
  q: string
  mode?: 'keyword' | 'semantic'
  channel?: string
  workspace?: string
  limit?: number
}): Promise<import('../types').SlackSearchResponse> {
  const searchParams = new URLSearchParams()
  searchParams.set('q', params.q)
  if (params.mode) searchParams.set('mode', params.mode)
  if (params.channel) searchParams.set('channel', params.channel)
  if (params.workspace) searchParams.set('workspace', params.workspace)
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit))
  return client.get('slack/search', { searchParams }).json()
}

export async function listSlackDocuments(params?: {
  limit?: number
  offset?: number
}): Promise<import('../types').SlackDocumentsResponse> {
  const searchParams = new URLSearchParams()
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params?.offset !== undefined) searchParams.set('offset', String(params.offset))
  return client.get('slack/documents', { searchParams }).json()
}

// ============ Source Code Search API ============

export async function searchSourceCode(params: {
  q: string
  language?: string
  repo?: string
  branch?: string
  limit?: number
  min_score?: number
}): Promise<import('../types').SourceCodeSearchResponse> {
  const searchParams = new URLSearchParams()
  searchParams.set('q', params.q)
  if (params.language) searchParams.set('language', params.language)
  if (params.repo) searchParams.set('repo', params.repo)
  if (params.branch) searchParams.set('branch', params.branch)
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params.min_score !== undefined) searchParams.set('min_score', String(params.min_score))
  return client.get('vector/source/search', { searchParams }).json()
}

export async function getSourceCodeFacets(params?: {
  repo?: string
}): Promise<import('../types').SourceCodeFacetsResponse> {
  const searchParams = new URLSearchParams()
  if (params?.repo) searchParams.set('repo', params.repo)
  return client.get('vector/source/facets', { searchParams }).json()
}

export async function searchDocs(params: {
  q: string
  project?: string
  tag?: string
  file_type?: string
  limit?: number
  min_score?: number
}): Promise<import('../types').DocSearchResponse> {
  const searchParams = new URLSearchParams()
  searchParams.set('q', params.q)
  if (params.project) searchParams.set('project', params.project)
  if (params.tag) searchParams.set('tag', params.tag)
  if (params.file_type) searchParams.set('file_type', params.file_type)
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params.min_score !== undefined) searchParams.set('min_score', String(params.min_score))
  return client.get('vector/docs/search', { searchParams }).json()
}

export async function getDocsFacets(): Promise<import('../types').DocFacetsResponse> {
  return client.get('vector/docs/facets').json()
}

export async function ingestSlack(params: {
  content?: string
  path?: string
  document_id: string
  mode?: 'replace' | 'append'
  metadata?: {
    channel?: string
    workspace?: string
    team?: string
    topic?: string
    date_range?: string
  }
}): Promise<{ document_id: string; chunks_created: number; collection: string }> {
  return client.post('slack/ingest', { json: params }).json()
}

export async function getSlackDocument(documentId: string): Promise<{
  document: {
    id: string
    document_id: string
    file_size: number
    metadata: Record<string, unknown> | null
    uploaded_at: string
    updated_at: string
    chunk_count: number
  }
}> {
  return client.get(`slack/documents/${encodeURIComponent(documentId)}`).json()
}

// ============ Slack Channels API ============

export async function listRegisteredSlackChannels(): Promise<{ channels: import('../types').SlackChannel[]; total_count: number }> {
  return client.get('slack/channels/registered').json()
}

export async function registerSlackChannel(body: {
  channel_id: string
  workspace_id: string
  channel_name: string
  workspace_name?: string
  channel_type?: string
  export_path?: string
}): Promise<{ channel: import('../types').SlackChannel }> {
  return client.post('slack/channels/register', { json: body }).json()
}

export async function updateSlackChannel(channelDbId: string, body: {
  channel_name?: string
  workspace_name?: string
  channel_type?: string
  export_path?: string
}): Promise<{ channel: import('../types').SlackChannel }> {
  return client.patch(`slack/channels/registered/${encodeURIComponent(channelDbId)}`, { json: body }).json()
}

export async function syncSlackChannel(channelDbId: string): Promise<{ job_id: string; run_id: string; channel: string; status: string }> {
  return client.post(`slack/channels/registered/${encodeURIComponent(channelDbId)}/sync`).json()
}

// ============ Assistant Chat API ============

export async function sendChatMessage(
  handle: string,
  body: import('../types').SendChatBody,
  signal?: AbortSignal,
): Promise<import('../types').SendChatResponse> {
  return client
    .post(`assistants/${encodeURIComponent(handle)}/chat`, { json: { ...body, source: 'ui' }, timeout: 180000, signal })
    .json()
}

export async function listChats(
  handle: string,
  params?: { project_id?: string; limit?: number; offset?: number }
): Promise<import('../types').AssistantChatsResponse> {
  const searchParams = new URLSearchParams()
  if (params?.project_id) searchParams.set('project_id', params.project_id)
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params?.offset !== undefined) searchParams.set('offset', String(params.offset))
  return client
    .get(`assistants/${encodeURIComponent(handle)}/chats`, { searchParams })
    .json()
}

export async function getChat(
  handle: string,
  id: string,
  includeMessages = false
): Promise<import('../types').AssistantChatDetailResponse> {
  const searchParams = new URLSearchParams()
  if (includeMessages) searchParams.set('include_messages', 'true')
  return client
    .get(`assistants/${encodeURIComponent(handle)}/chats/${id}`, { searchParams })
    .json()
}

export async function getChatMessages(
  handle: string,
  chatId: string,
  params?: { limit?: number; offset?: number; order?: 'asc' | 'desc' }
): Promise<import('../types').AssistantChatMessagesResponse> {
  const searchParams = new URLSearchParams()
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params?.offset !== undefined) searchParams.set('offset', String(params.offset))
  if (params?.order) searchParams.set('order', params.order)
  return client
    .get(`assistants/${encodeURIComponent(handle)}/chats/${chatId}/messages`, { searchParams })
    .json()
}

export async function deleteChat(handle: string, id: string): Promise<void> {
  await client.delete(`assistants/${encodeURIComponent(handle)}/chats/${id}`)
}

// Handle-less chat endpoints (cross-backend)

export async function listAllChats(
  params?: { project_id?: string; source?: string; assistant_handle?: string; limit?: number; offset?: number }
): Promise<import('../types').AssistantChatsResponse> {
  const searchParams = new URLSearchParams()
  if (params?.project_id) searchParams.set('project_id', params.project_id)
  if (params?.source) searchParams.set('source', params.source)
  if (params?.assistant_handle) searchParams.set('assistant_handle', params.assistant_handle)
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params?.offset !== undefined) searchParams.set('offset', String(params.offset))
  return client.get('chats', { searchParams }).json()
}

export async function getChatById(
  id: string,
  includeMessages = false
): Promise<import('../types').AssistantChatDetailResponse> {
  const searchParams = new URLSearchParams()
  if (includeMessages) searchParams.set('include_messages', 'true')
  return client.get(`chats/${id}`, { searchParams }).json()
}

export async function deleteChatById(id: string): Promise<void> {
  await client.delete(`chats/${id}`)
}

export async function renameChatById(id: string, title: string): Promise<import('../types').AssistantChatDetailResponse> {
  return client.patch(`chats/${id}`, { json: { title } }).json()
}

export async function deleteChatMessageById(chatId: string, messageId: string): Promise<void> {
  await client.delete(`chats/${chatId}/messages/${messageId}`)
}

export async function deleteAllChats(): Promise<void> {
  await client.delete('chats/all')
}

// ============ Collections ============

export async function getAllCollections(): Promise<{
  collections: Array<{
    id: string; handle: string; name: string; description: string | null
    project_id: string; project_handle: string; project_name: string; memory_count: number
  }>
}> {
  return client.get('collections').json()
}

export async function getProjectCollections(
  projectId: string,
  params?: { limit?: number; offset?: number; parent_id?: string }
): Promise<import('../types').CollectionsResponse> {
  const searchParams = new URLSearchParams()
  if (params?.limit) searchParams.set('limit', String(params.limit))
  if (params?.offset) searchParams.set('offset', String(params.offset))
  if (params?.parent_id) searchParams.set('parent_id', params.parent_id)
  return client.get(`projects/${projectId}/collections`, { searchParams }).json()
}

export async function createCollection(
  projectId: string,
  data: { handle: string; name: string; description?: string; parent_id?: string; view_mode?: import('../types').CollectionViewMode }
): Promise<import('../types').CollectionResponse> {
  return client.post(`projects/${projectId}/collections`, { json: data }).json()
}

export async function getCollection(
  projectId: string,
  collectionId: string
): Promise<import('../types').CollectionResponse> {
  return client.get(`projects/${projectId}/collections/${collectionId}`).json()
}

export async function updateCollection(
  projectId: string,
  collectionId: string,
  data: { name?: string; description?: string | null; view_mode?: import('../types').CollectionViewMode; board_config?: import('../types').BoardConfig; parent_id?: string | null }
): Promise<{ collection: import('../types').Collection }> {
  return client.patch(`projects/${projectId}/collections/${collectionId}`, { json: data }).json()
}

export async function getCollectionBoard(
  projectId: string,
  collectionId: string
): Promise<import('../types').BoardResponse> {
  return client.get(`projects/${projectId}/collections/${collectionId}/board`).json()
}

export async function deleteCollection(
  projectId: string,
  collectionId: string
): Promise<void> {
  await client.delete(`projects/${projectId}/collections/${collectionId}`)
}

export async function addToCollection(
  projectId: string,
  collectionId: string,
  memoryId: string,
  position?: number
): Promise<{ collection_id: string; memory_id: string; position: number }> {
  return client.post(`projects/${projectId}/collections/${collectionId}/memories`, {
    json: { memory_id: memoryId, position },
  }).json()
}

export async function removeFromCollection(
  projectId: string,
  collectionId: string,
  memoryId: string
): Promise<void> {
  await client.delete(`projects/${projectId}/collections/${collectionId}/memories/${memoryId}`)
}

export async function reorderCollection(
  projectId: string,
  collectionId: string,
  items: Array<{ memory_id: string; position: number }>
): Promise<{ success: boolean }> {
  return client.put(`projects/${projectId}/collections/${collectionId}/memories/reorder`, {
    json: { items },
  }).json()
}

export async function getMemoryCollections(
  projectId: string,
  memoryId: string
): Promise<{ collections: Array<{ id: string; handle: string; name: string; project_id: string; project_handle: string; project_name: string }> }> {
  return client.get(`projects/${projectId}/memories/${memoryId}/collections`).json()
}

// ============ Filesystem API ============

export async function fsTree(
  fsPath: string,
  depth?: number,
  showHidden?: boolean
): Promise<import('../types').FsTreeResponse> {
  const searchParams = new URLSearchParams({ path: fsPath })
  if (depth !== undefined) searchParams.set('depth', String(depth))
  if (showHidden) searchParams.set('showHidden', 'true')
  return client.get('fs/tree', { searchParams }).json()
}

export async function fsFind(
  fsPath: string,
  limit?: number,
  q?: string,
  showHidden?: boolean
): Promise<import('../types').FsFindResponse> {
  const searchParams = new URLSearchParams({ path: fsPath })
  if (limit !== undefined) searchParams.set('limit', String(limit))
  if (q) searchParams.set('q', q)
  if (showHidden) searchParams.set('showHidden', 'true')
  return client.get('fs/find', { searchParams }).json()
}

export async function fsRead(
  fsPath: string
): Promise<import('../types').FsReadResponse> {
  const searchParams = new URLSearchParams({ path: fsPath })
  return client.get('fs/read', { searchParams }).json()
}

export async function fsWrite(
  fsPath: string,
  content: string,
  expectedModified?: string
): Promise<import('../types').FsWriteResponse> {
  const body: Record<string, string> = { path: fsPath, content }
  if (expectedModified) body.expectedModified = expectedModified
  return client.put('fs/write', { json: body }).json()
}

export async function fsStat(
  fsPath: string
): Promise<import('../types').FsStatResponse> {
  const searchParams = new URLSearchParams({ path: fsPath })
  return client.get('fs/stat', { searchParams }).json()
}

export async function fsNew(
  fsPath: string,
  type: 'file' | 'directory'
): Promise<import('../types').FsNewResponse> {
  return client.post('fs/new', { json: { path: fsPath, type } }).json()
}

export async function fsDelete(
  fsPath: string
): Promise<import('../types').FsDeleteResponse> {
  return client.delete('fs/delete', { json: { path: fsPath } }).json()
}

export async function fsCompletions(
  prefix: string
): Promise<import('../types').FsCompletionsResponse> {
  const searchParams = new URLSearchParams({ prefix })
  return client.get('fs/completions', { searchParams }).json()
}

export async function fsReveal(fsPath: string): Promise<void> {
  await client.post('fs/reveal', { json: { path: fsPath } })
}

export async function getScratchHome(): Promise<{ path: string; is_default: boolean }> {
  return client.get('editor/scratch-home').json()
}

export async function fsSearch(
  fsPath: string,
  q: string,
  options?: { regex?: boolean; caseSensitive?: boolean; include?: string; limit?: number }
): Promise<import('../types').FsSearchResponse> {
  const searchParams = new URLSearchParams({ path: fsPath, q })
  if (options?.regex) searchParams.set('regex', 'true')
  if (options?.caseSensitive) searchParams.set('caseSensitive', 'true')
  if (options?.include) searchParams.set('include', options.include)
  if (options?.limit) searchParams.set('limit', String(options.limit))
  return client.get('fs/search', { searchParams }).json()
}

// Agent questions (ephemeral Q&A panel)

export interface AgentQuestionField {
  key: string
  type: 'single-choice' | 'multi-choice' | 'text' | 'textarea' | 'number' | 'toggle'
  label: string
  description?: string
  placeholder?: string
  hint?: string
  required?: boolean
  options?: { value: string; label: string; hint?: string }[]
  default?: unknown
  min?: number
  max?: number
}

export interface AgentQuestion {
  id: string
  agent: { session_id?: string; nickname?: string; assistant_handle?: string }
  title: string
  description?: string
  fields: AgentQuestionField[]
  created_at: string
  expires_at: string
  status: 'pending' | 'answered' | 'canceled' | 'expired'
}

export interface AgentAnswer {
  question_id: string
  answered_at: string
  values: Record<string, unknown>
}

export async function listAgentQuestions(opts?: { nickname?: string; limit?: number }): Promise<{
  questions: AgentQuestion[]
  count: number
}> {
  const params = new URLSearchParams()
  if (opts?.nickname) params.set('nickname', opts.nickname)
  if (opts?.limit) params.set('limit', String(opts.limit))
  return client.get(`agent-questions${params.toString() ? `?${params}` : ''}`).json()
}

export async function getAgentQuestion(id: string): Promise<{
  question: AgentQuestion
  answer: AgentAnswer | null
}> {
  return client.get(`agent-questions/${encodeURIComponent(id)}`).json()
}

export async function answerAgentQuestion(
  id: string,
  values: Record<string, unknown>,
): Promise<{ answer: AgentAnswer }> {
  return client
    .post(`agent-questions/${encodeURIComponent(id)}/answer`, { json: { values } })
    .json()
}

export async function cancelAgentQuestion(id: string): Promise<{ canceled: boolean }> {
  return client.delete(`agent-questions/${encodeURIComponent(id)}`).json()
}

export interface AgentQuestionEvent {
  type: 'question.created' | 'question.answered' | 'question.canceled' | 'question.expired'
  question_id: string
  question?: AgentQuestion
  answer?: AgentAnswer
  at: string
}

/**
 * Subscribe to agent question events via the shared SSE singleton. Returns a
 * subscription handle with `.close()` so the caller can detach on unmount.
 * All four event types (`question.created`, `question.answered`,
 * `question.canceled`, `question.expired`) fire on `onEvent`; the
 * discriminator is `event.type`.
 */
export function openAgentQuestionStream(
  onEvent: (event: AgentQuestionEvent) => void,
  opts?: { nickname?: string },
): { close: () => void } {
  const room = opts?.nickname
    ? `agent-questions:${opts.nickname.toLowerCase()}`
    : 'agent-questions'
  const unsubscribe = sseSubscribe([room], (_room, delta) => {
    onEvent(delta as AgentQuestionEvent)
  })
  return { close: unsubscribe }
}
