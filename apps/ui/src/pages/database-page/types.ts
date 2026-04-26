import type { DbxTableDetail, DbxQueryResult, DbxErdData, DbxSchemaErdData } from '../../lib/dbx-api'

export interface TreeNode {
  type: 'connection' | 'schema' | 'folder' | 'table' | 'view' | 'column' | 'function' | 'trigger'
  name: string
  connectionId?: string
  schema?: string
  badge?: string
  children?: TreeNode[]
  isOpen?: boolean
  detail?: any
}

export interface SqlTab {
  kind: 'sql'
  id: string
  name: string
  content: string
  scriptId?: string
  connectionId: string
  isDirty: boolean
}

export interface DetailViewTab {
  kind: 'detail'
  id: string
  name: string
  connectionId: string
  schema: string
  tableName: string
  tableDetail: DbxTableDetail | null
  tableData: DbxQueryResult | null
  erdData: DbxErdData | null
  detailTab: 'properties' | 'data' | 'diagram'
  propsSubtab: PropsSubtab
}

export interface CodeViewTab {
  kind: 'code-view'
  id: string
  name: string
  connectionId: string
  schema: string
  objectType: 'function' | 'trigger'
  objectName: string
  definition: string | null
  metadata: Record<string, string>
}

export interface SchemaErdTab {
  kind: 'schema-erd'
  id: string
  name: string
  connectionId: string
  schema: string
  erdData: DbxSchemaErdData | null
}

export type Tab = SqlTab | DetailViewTab | CodeViewTab | SchemaErdTab
export type ResultTab = 'results' | 'messages' | 'history'
export type PropsSubtab = 'columns' | 'constraints' | 'fks' | 'indexes' | 'triggers' | 'definition' | 'dependencies'

export interface Message {
  text: string
  type: 'success' | 'error' | 'info'
  ts: string
}
