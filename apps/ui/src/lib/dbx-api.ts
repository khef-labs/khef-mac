/**
 * Database Explorer (dbx) API client
 */
import ky from 'ky'

const envApiBase = (typeof process !== 'undefined' && process.env?.KHEF_API_URL) || ''

const API_BASE = (() => {
  return (
    envApiBase ||
    (typeof window !== 'undefined' && window.location?.origin
      ? `${window.location.origin}/api`
      : 'http://localhost:3000/api')
  )
})()

const client = ky.create({
  prefixUrl: API_BASE,
  timeout: 60000, // longer timeout for queries
})

// ── Types ──

export interface DbxConnection {
  id: string
  name: string
  driver: string
  config: Record<string, any>
  credentials?: Record<string, any> | null
  is_builtin: boolean
  options: Record<string, any>
  created_at: string
  updated_at: string
}

export interface DbxSchema {
  name: string
  table_count: number
  view_count: number
  size: string | null
}

export interface DbxTableInfo {
  name: string
  type: 'table' | 'view'
  row_estimate: number
  size: string | null
  comment: string | null
}

export interface DbxColumnInfo {
  position: number
  name: string
  data_type: string
  is_nullable: boolean
  column_default: string | null
  identity: string | null
  comment: string | null
}

export interface DbxConstraint {
  name: string
  type: string
  columns: string[]
  expression: string | null
}

export interface DbxForeignKey {
  name: string
  columns: string[]
  referenced_schema: string
  referenced_table: string
  referenced_columns: string[]
  on_update: string
  on_delete: string
}

export interface DbxIndex {
  name: string
  columns: string[]
  is_unique: boolean
  type: string
  size: string | null
  definition: string
}

export interface DbxTrigger {
  name: string
  event: string
  timing: string
  function_name: string
  definition: string
}

export interface DbxTableDetail {
  name: string
  type: 'table' | 'view'
  schema: string
  oid: number
  row_estimate: number
  size: string | null
  tablespace: string | null
  has_rls: boolean
  comment: string | null
  columns: DbxColumnInfo[]
  constraints: DbxConstraint[]
  foreign_keys: DbxForeignKey[]
  indexes: DbxIndex[]
  triggers: DbxTrigger[]
  definition: string | null
  dependencies: string[] | null
}

export interface DbxConnectionOverview {
  version: string
  uptime: string | null
  database_size: string
  active_connections: number
  schemas: DbxSchema[]
}

export interface DbxQueryColumn {
  name: string
  type: string
  type_oid?: number
}

export interface DbxQueryResult {
  columns: DbxQueryColumn[]
  rows: any[][]
  rowCount: number
  duration: number
  affectedRows: number | null
  truncated: boolean
  queryId: string
}

export interface DbxScript {
  id: string
  connection_id: string | null
  name: string
  content: string
  created_at: string
  updated_at: string
}

export interface DbxQueryHistoryEntry {
  id: string
  connection_id: string
  sql: string
  row_count: number | null
  duration_ms: number | null
  error: string | null
  created_at: string
}

export interface ConnectionTestResult {
  ok: boolean
  error?: string
  version?: string
}

// ── Connections ──

export async function getConnections(): Promise<{ connections: DbxConnection[] }> {
  return client.get('dbx/connections').json()
}

export async function createConnection(data: {
  name: string
  driver: string
  config: Record<string, any>
  credentials?: Record<string, any>
  options?: Record<string, any>
}): Promise<{ connection: DbxConnection }> {
  return client.post('dbx/connections', { json: data }).json()
}

export async function updateConnection(id: string, data: {
  name?: string
  config?: Record<string, any>
  credentials?: Record<string, any>
  options?: Record<string, any>
}): Promise<{ connection: DbxConnection }> {
  return client.patch(`dbx/connections/${id}`, { json: data }).json()
}

export async function deleteConnection(id: string): Promise<void> {
  await client.delete(`dbx/connections/${id}`)
}

export async function testConnection(id: string): Promise<ConnectionTestResult> {
  return client.post(`dbx/connections/${id}/test`).json()
}

export async function testConnectionConfig(data: {
  driver: string
  config: Record<string, any>
  credentials?: Record<string, any>
  options?: Record<string, any>
}): Promise<ConnectionTestResult> {
  return client.post('dbx/connections/test', { json: data }).json()
}

export async function getConnectionOverview(id: string): Promise<DbxConnectionOverview> {
  return client.get(`dbx/connections/${id}/overview`).json()
}

// ── Schema introspection ──

export async function getSchemas(connectionId: string): Promise<{ schemas: DbxSchema[] }> {
  return client.get(`dbx/connections/${connectionId}/schemas`).json()
}

export async function getTables(connectionId: string, schema: string): Promise<{ tables: DbxTableInfo[] }> {
  return client.get(`dbx/connections/${connectionId}/schemas/${schema}/tables`).json()
}

export async function getTableDetail(connectionId: string, schema: string, table: string): Promise<{ table: DbxTableDetail }> {
  return client.get(`dbx/connections/${connectionId}/schemas/${schema}/tables/${table}`).json()
}

export async function getTableData(
  connectionId: string,
  schema: string,
  table: string,
  params?: { limit?: number; offset?: number; sort?: string; order?: string; where?: string }
): Promise<DbxQueryResult> {
  const searchParams = new URLSearchParams()
  if (params?.limit) searchParams.set('limit', String(params.limit))
  if (params?.offset) searchParams.set('offset', String(params.offset))
  if (params?.sort) searchParams.set('sort', params.sort)
  if (params?.order) searchParams.set('order', params.order)
  if (params?.where) searchParams.set('where', params.where)
  return client.get(`dbx/connections/${connectionId}/schemas/${schema}/tables/${table}/data`, { searchParams }).json()
}

// ── Functions & Triggers ──

export interface DbxFunctionInfo {
  name: string
  return_type: string
  arguments: string
  kind: string
  language: string
  volatility: string
  comment: string | null
}

export interface DbxFunctionDetail extends DbxFunctionInfo {
  security_definer: boolean
  definition: string | null
}

export interface DbxSchemaTriggerInfo {
  name: string
  table_name: string
  timing: string
  events: string
  function_name: string
  enabled: string
  definition: string
}

export async function getFunctions(connectionId: string, schema: string): Promise<{ functions: DbxFunctionInfo[] }> {
  return client.get(`dbx/connections/${connectionId}/schemas/${schema}/functions`).json()
}

export async function getFunctionDetail(connectionId: string, schema: string, name: string, args?: string): Promise<{ function: DbxFunctionDetail }> {
  const searchParams = new URLSearchParams()
  if (args) searchParams.set('args', args)
  return client.get(`dbx/connections/${connectionId}/schemas/${schema}/functions/${encodeURIComponent(name)}`, { searchParams }).json()
}

export async function getSchemaTriggers(connectionId: string, schema: string): Promise<{ triggers: DbxSchemaTriggerInfo[] }> {
  return client.get(`dbx/connections/${connectionId}/schemas/${schema}/triggers`).json()
}

// ── ERD ──

export interface DbxErdData {
  focused: DbxTableDetail
  related: Record<string, DbxTableDetail>
  reverse_fks: { source_schema: string; source_table: string; source_column: string; target_column: string }[]
}

export async function getTableErd(connectionId: string, schema: string, table: string): Promise<DbxErdData> {
  return client.get(`dbx/connections/${connectionId}/schemas/${schema}/tables/${table}/erd`).json()
}

export interface DbxSchemaErdData {
  schema: string
  tables: Record<string, DbxTableDetail>
  table_count: number
}

export async function getSchemaErd(connectionId: string, schema: string, compact = false): Promise<DbxSchemaErdData> {
  const searchParams = new URLSearchParams()
  if (compact) searchParams.set('compact', 'true')
  return client.get(`dbx/connections/${connectionId}/schemas/${schema}/erd`, { searchParams }).json()
}

export interface DbxSaveErdResult {
  memory_id: string
  project_id: string
  collection_id: string
  created: boolean
  url: string
}

export async function saveErd(data: {
  connection_name: string
  schema: string
  table?: string
  mermaid: string
}): Promise<DbxSaveErdResult> {
  return client.post('dbx/erd/save', { json: data }).json()
}

// ── Query execution ──

export async function executeQuery(
  connectionId: string,
  sql: string,
  options?: { timeout?: number; maxRows?: number }
): Promise<DbxQueryResult> {
  try {
    return await client.post(`dbx/connections/${connectionId}/query`, {
      json: { sql, ...options },
    }).json()
  } catch (err: any) {
    // Extract the actual error message from the response body
    if (err.response) {
      try {
        const body = await err.response.json()
        if (body?.error) {
          throw new Error(body.error)
        }
      } catch (parseErr: any) {
        if (parseErr.message && parseErr.message !== err.message) throw parseErr
      }
    }
    throw err
  }
}

export async function cancelQuery(connectionId: string, queryId: string): Promise<void> {
  await client.post(`dbx/connections/${connectionId}/query/cancel`, {
    json: { queryId },
  })
}

// ── Scripts ──

export async function getScripts(connectionId?: string): Promise<{ scripts: DbxScript[] }> {
  const searchParams = connectionId ? { connection_id: connectionId } : undefined
  return client.get('dbx/scripts', { searchParams }).json()
}

export async function getScript(id: string): Promise<{ script: DbxScript }> {
  return client.get(`dbx/scripts/${id}`).json()
}

export async function createScript(data: {
  name: string
  content?: string
  connection_id?: string
}): Promise<{ script: DbxScript }> {
  return client.post('dbx/scripts', { json: data }).json()
}

export async function updateScript(id: string, data: {
  name?: string
  content?: string
  connection_id?: string
}): Promise<{ script: DbxScript }> {
  return client.patch(`dbx/scripts/${id}`, { json: data }).json()
}

export async function deleteScript(id: string): Promise<void> {
  await client.delete(`dbx/scripts/${id}`)
}

// ── History ──

export async function getQueryHistory(
  connectionId: string,
  params?: { limit?: number; offset?: number }
): Promise<{ history: DbxQueryHistoryEntry[]; pagination: { total_count: number; limit: number; offset: number; has_more: boolean } }> {
  const searchParams = new URLSearchParams()
  if (params?.limit) searchParams.set('limit', String(params.limit))
  if (params?.offset) searchParams.set('offset', String(params.offset))
  return client.get(`dbx/connections/${connectionId}/history`, { searchParams }).json()
}

export async function clearQueryHistory(connectionId: string): Promise<void> {
  await client.delete(`dbx/connections/${connectionId}/history`)
}
