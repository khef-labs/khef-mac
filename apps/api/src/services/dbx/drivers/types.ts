export interface ColumnInfo {
  position: number;
  name: string;
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
  identity: string | null;
  collation: string | null;
  comment: string | null;
}

export interface ConstraintInfo {
  name: string;
  type: string; // PRIMARY KEY, UNIQUE, CHECK, EXCLUDE
  columns: string[];
  expression: string | null;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referenced_table: string;
  referenced_schema: string;
  referenced_columns: string[];
  on_update: string;
  on_delete: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  is_unique: boolean;
  type: string; // btree, gin, gist, hash, etc.
  size: string | null;
  definition: string;
}

export interface TriggerInfo {
  name: string;
  event: string;
  timing: string;
  function_name: string;
  definition: string;
}

export interface SchemaInfo {
  name: string;
  table_count: number;
  view_count: number;
  size: string | null;
}

export interface TableInfo {
  name: string;
  type: 'table' | 'view';
  row_estimate: number;
  size: string | null;
  comment: string | null;
}

export interface TableDetail {
  name: string;
  type: 'table' | 'view';
  schema: string;
  oid: number;
  row_estimate: number;
  size: string | null;
  tablespace: string | null;
  has_rls: boolean;
  comment: string | null;
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  foreign_keys: ForeignKeyInfo[];
  indexes: IndexInfo[];
  triggers: TriggerInfo[];
  // View-specific
  definition: string | null;
  dependencies: string[] | null;
}

export interface FunctionInfo {
  name: string;
  return_type: string;
  arguments: string;
  kind: string; // function, procedure, aggregate, window
  language: string;
  volatility: string;
  comment: string | null;
}

export interface FunctionDetail extends FunctionInfo {
  security_definer: boolean;
  definition: string | null;
}

export interface SchemaTriggerInfo {
  name: string;
  table_name: string;
  timing: string;
  events: string;
  function_name: string;
  enabled: string;
  definition: string;
}

export interface QueryOptions {
  timeout?: number;
  maxRows?: number;
  queryId?: string;
  params?: any[];
  readOnly?: boolean;
}

export interface QueryResultColumn {
  name: string;
  type: string;
  type_oid?: number;
}

export interface QueryResult {
  columns: QueryResultColumn[];
  rows: any[][];
  rowCount: number;
  duration: number;
  affectedRows: number | null;
  truncated: boolean;
  queryId: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  error?: string;
  version?: string;
}

export interface ConnectionOverview {
  version: string;
  uptime: string | null;
  database_size: string;
  active_connections: number;
  schemas: SchemaInfo[];
}

export interface SqlDriver {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  testConnection(): Promise<ConnectionTestResult>;
  getOverview(): Promise<ConnectionOverview>;
  getSchemas(): Promise<SchemaInfo[]>;
  getTables(schema: string): Promise<TableInfo[]>;
  getFunctions(schema: string): Promise<FunctionInfo[]>;
  getFunctionDetail(schema: string, name: string, argTypes?: string): Promise<FunctionDetail>;
  getSchemaTriggers(schema: string): Promise<SchemaTriggerInfo[]>;
  describeTable(schema: string, table: string): Promise<TableDetail>;
  getTableData(schema: string, table: string, options?: { limit?: number; offset?: number; sort?: string; order?: string; where?: string }): Promise<QueryResult>;
  executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult>;
  cancelQuery(queryId: string): Promise<void>;
}

export interface DbxConnection {
  id: string;
  name: string;
  driver: string;
  config: Record<string, any>;
  credentials: Record<string, any> | null;
  is_builtin: boolean;
  options: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface DbxScript {
  id: string;
  connection_id: string | null;
  name: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface DbxQueryHistory {
  id: string;
  connection_id: string;
  sql: string;
  row_count: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
}
