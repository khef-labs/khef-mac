import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { logger } from '../../../lib/logger';
import type {
  SqlDriver,
  ConnectionTestResult,
  ConnectionOverview,
  SchemaInfo,
  TableInfo,
  TableDetail,
  FunctionInfo,
  FunctionDetail,
  SchemaTriggerInfo,
  QueryOptions,
  QueryResult,
} from './types';

const log = logger.child({ component: 'dbx-postgres' });

const PG_TYPE_MAP: Record<number, string> = {
  16: 'bool', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 26: 'oid',
  700: 'float4', 701: 'float8', 1042: 'bpchar', 1043: 'varchar',
  1082: 'date', 1114: 'timestamp', 1184: 'timestamptz',
  1700: 'numeric', 2950: 'uuid', 3802: 'jsonb', 114: 'json',
  3614: 'tsvector', 1009: 'text[]', 1015: 'varchar[]', 1016: 'int8[]',
  1007: 'int4[]',
};

export class PostgresDriver implements SqlDriver {
  private pool: Pool | null = null;
  private activeQueries = new Map<string, PoolClient>();
  private config: {
    host: string;
    port: number;
    database: string;
    user?: string;
    password?: string;
    ssl?: boolean;
  };
  private statementTimeout: number;

  constructor(
    config: Record<string, any>,
    credentials: Record<string, any> | null,
    options: Record<string, any>
  ) {
    this.config = {
      host: config.host || 'localhost',
      port: config.port || 5432,
      database: config.database || 'postgres',
      user: credentials?.username,
      password: credentials?.password,
      ssl: options?.ssl || false,
    };
    this.statementTimeout = options?.statement_timeout_ms || 30000;
  }

  async connect(): Promise<void> {
    if (this.pool) return;
    this.pool = new Pool({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 300000, // 5 min
      connectionTimeoutMillis: 5000,
    });
    this.pool.on('error', (err) => {
      log.error({ err }, 'Pool error');
    });
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  private getPool(): Pool {
    if (!this.pool) throw new Error('Not connected');
    return this.pool;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    let tempPool: Pool | null = null;
    try {
      tempPool = new Pool({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
        max: 1,
        connectionTimeoutMillis: 5000,
      });
      const result = await tempPool.query('SELECT version()');
      return { ok: true, version: result.rows[0].version };
    } catch (err: any) {
      return { ok: false, error: err.message };
    } finally {
      if (tempPool) await tempPool.end();
    }
  }

  async getOverview(): Promise<ConnectionOverview> {
    const pool = this.getPool();

    const [versionRow, sizeRow, connRow, uptimeRow, schemas] = await Promise.all([
      pool.query('SELECT version()'),
      pool.query('SELECT pg_size_pretty(pg_database_size(current_database())) as size'),
      pool.query('SELECT count(*) as cnt FROM pg_stat_activity WHERE datname = current_database()'),
      pool.query("SELECT date_trunc('second', current_timestamp - pg_postmaster_start_time()) as uptime"),
      this.getSchemas(),
    ]);

    return {
      version: versionRow.rows[0].version,
      uptime: uptimeRow.rows[0].uptime?.toString() || null,
      database_size: sizeRow.rows[0].size,
      active_connections: parseInt(connRow.rows[0].cnt, 10),
      schemas,
    };
  }

  async getSchemas(): Promise<SchemaInfo[]> {
    const pool = this.getPool();
    const result = await pool.query(`
      SELECT
        n.nspname as name,
        COUNT(CASE WHEN c.relkind = 'r' THEN 1 END)::int as table_count,
        COUNT(CASE WHEN c.relkind = 'v' THEN 1 END)::int as view_count,
        pg_size_pretty(SUM(pg_total_relation_size(c.oid)) FILTER (WHERE c.relkind = 'r')) as size
      FROM pg_namespace n
      LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r', 'v')
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND n.nspname NOT LIKE 'pg_temp_%'
      GROUP BY n.nspname
      ORDER BY n.nspname
    `);
    return result.rows;
  }

  async getTables(schema: string): Promise<TableInfo[]> {
    const pool = this.getPool();
    const result = await pool.query(`
      SELECT
        c.relname as name,
        CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' END as type,
        c.reltuples::bigint as row_estimate,
        CASE WHEN c.relkind = 'r' THEN pg_size_pretty(pg_total_relation_size(c.oid)) END as size,
        obj_description(c.oid) as comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'v')
      ORDER BY c.relkind, c.relname
    `, [schema]);
    return result.rows;
  }

  async getFunctions(schema: string): Promise<FunctionInfo[]> {
    const pool = this.getPool();
    const result = await pool.query(`
      SELECT
        p.proname as name,
        pg_get_function_result(p.oid) as return_type,
        pg_get_function_arguments(p.oid) as arguments,
        CASE p.prokind WHEN 'f' THEN 'function' WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window' END as kind,
        l.lanname as language,
        CASE WHEN p.provolatile = 'i' THEN 'IMMUTABLE' WHEN p.provolatile = 's' THEN 'STABLE' ELSE 'VOLATILE' END as volatility,
        obj_description(p.oid, 'pg_proc') as comment
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = $1
        AND p.prokind IN ('f', 'p', 'a', 'w')
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.objid = p.oid AND d.deptype = 'e'
        )
      ORDER BY p.proname
    `, [schema]);
    return result.rows;
  }

  async getFunctionDetail(schema: string, name: string, argTypes?: string): Promise<FunctionDetail> {
    const pool = this.getPool();
    // Find the function — if argTypes given, match exactly; otherwise take first match
    const lookupSql = argTypes
      ? `SELECT p.oid, p.proname, pg_get_function_arguments(p.oid) as arguments,
           pg_get_function_result(p.oid) as return_type,
           CASE p.prokind WHEN 'f' THEN 'function' WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window' END as kind,
           l.lanname as language,
           CASE WHEN p.provolatile = 'i' THEN 'IMMUTABLE' WHEN p.provolatile = 's' THEN 'STABLE' ELSE 'VOLATILE' END as volatility,
           p.prosecdef as security_definer,
           obj_description(p.oid, 'pg_proc') as comment
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_language l ON l.oid = p.prolang
         WHERE n.nspname = $1 AND p.proname = $2 AND pg_get_function_arguments(p.oid) = $3`
      : `SELECT p.oid, p.proname, pg_get_function_arguments(p.oid) as arguments,
           pg_get_function_result(p.oid) as return_type,
           CASE p.prokind WHEN 'f' THEN 'function' WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window' END as kind,
           l.lanname as language,
           CASE WHEN p.provolatile = 'i' THEN 'IMMUTABLE' WHEN p.provolatile = 's' THEN 'STABLE' ELSE 'VOLATILE' END as volatility,
           p.prosecdef as security_definer,
           obj_description(p.oid, 'pg_proc') as comment
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_language l ON l.oid = p.prolang
         WHERE n.nspname = $1 AND p.proname = $2
         LIMIT 1`;
    const params = argTypes ? [schema, name, argTypes] : [schema, name];
    const result = await pool.query(lookupSql, params);
    if (result.rows.length === 0) throw new Error(`Function ${schema}.${name} not found`);
    const row = result.rows[0];

    // Get source
    const srcResult = await pool.query(`SELECT pg_get_functiondef($1::oid) as definition`, [parseInt(row.oid, 10)]);

    return {
      name: row.proname,
      arguments: row.arguments,
      return_type: row.return_type,
      kind: row.kind,
      language: row.language,
      volatility: row.volatility,
      security_definer: row.security_definer,
      comment: row.comment,
      definition: srcResult.rows[0]?.definition || null,
    };
  }

  async getSchemaTriggers(schema: string): Promise<SchemaTriggerInfo[]> {
    const pool = this.getPool();
    const result = await pool.query(`
      SELECT
        t.tgname as name,
        c.relname as table_name,
        CASE
          WHEN t.tgtype & 2 = 2 THEN 'BEFORE'
          WHEN t.tgtype & 64 = 64 THEN 'INSTEAD OF'
          ELSE 'AFTER'
        END as timing,
        array_to_string(ARRAY[
          CASE WHEN t.tgtype & 4 = 4 THEN 'INSERT' END,
          CASE WHEN t.tgtype & 8 = 8 THEN 'DELETE' END,
          CASE WHEN t.tgtype & 16 = 16 THEN 'UPDATE' END,
          CASE WHEN t.tgtype & 32 = 32 THEN 'TRUNCATE' END
        ]::text[], ' OR ') as events,
        p.proname as function_name,
        t.tgenabled as enabled,
        pg_get_triggerdef(t.oid) as definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = $1
        AND NOT t.tgisinternal
      ORDER BY c.relname, t.tgname
    `, [schema]);
    return result.rows;
  }

  async describeTable(schema: string, table: string): Promise<TableDetail> {
    const pool = this.getPool();

    // Base info
    const baseResult = await pool.query(`
      SELECT
        c.oid,
        c.relkind,
        c.reltuples::bigint as row_estimate,
        CASE WHEN c.relkind = 'r' THEN pg_size_pretty(pg_total_relation_size(c.oid)) END as size,
        ts.spcname as tablespace,
        c.relrowsecurity as has_rls,
        obj_description(c.oid) as comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace
      WHERE n.nspname = $1 AND c.relname = $2
    `, [schema, table]);

    if (baseResult.rows.length === 0) {
      throw new Error(`Table ${schema}.${table} not found`);
    }

    const base = baseResult.rows[0];
    const isView = base.relkind === 'v';
    const oid = parseInt(base.oid, 10);

    // Columns
    const colResult = await pool.query(`
      SELECT
        a.attnum as position,
        a.attname as name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
        NOT a.attnotnull as is_nullable,
        pg_get_expr(d.adbin, d.adrelid) as column_default,
        CASE a.attidentity WHEN 'a' THEN 'ALWAYS' WHEN 'd' THEN 'BY DEFAULT' ELSE NULL END as identity,
        col_description(a.attrelid, a.attnum) as comment
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = $1
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum
    `, [oid]);

    // Constraints (tables only)
    let constraints: any[] = [];
    let foreignKeys: any[] = [];
    let indexes: any[] = [];
    let triggers: any[] = [];

    if (!isView) {
      // Constraints
      const conResult = await pool.query(`
        SELECT
          con.conname as name,
          CASE con.contype
            WHEN 'p' THEN 'PRIMARY KEY'
            WHEN 'u' THEN 'UNIQUE'
            WHEN 'c' THEN 'CHECK'
            WHEN 'x' THEN 'EXCLUDE'
          END as type,
          array_agg(a.attname ORDER BY array_position(con.conkey, a.attnum)) as columns,
          pg_get_constraintdef(con.oid) as expression
        FROM pg_constraint con
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
        WHERE con.conrelid = $1
          AND con.contype IN ('p', 'u', 'c', 'x')
        GROUP BY con.oid, con.conname, con.contype
        ORDER BY con.contype, con.conname
      `, [oid]);
      constraints = conResult.rows;

      // Foreign keys
      const fkResult = await pool.query(`
        SELECT
          con.conname as name,
          array_agg(a.attname ORDER BY array_position(con.conkey, a.attnum)) as columns,
          rn.nspname as referenced_schema,
          rc.relname as referenced_table,
          array_agg(ra.attname ORDER BY array_position(con.confkey, ra.attnum)) as referenced_columns,
          CASE con.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END as on_update,
          CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END as on_delete
        FROM pg_constraint con
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
        JOIN pg_class rc ON rc.oid = con.confrelid
        JOIN pg_namespace rn ON rn.oid = rc.relnamespace
        JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = ANY(con.confkey)
        WHERE con.conrelid = $1 AND con.contype = 'f'
        GROUP BY con.oid, con.conname, rn.nspname, rc.relname, con.confupdtype, con.confdeltype
        ORDER BY con.conname
      `, [oid]);
      foreignKeys = fkResult.rows;

      // Indexes
      const idxResult = await pool.query(`
        SELECT
          i.relname as name,
          array_agg(a.attname ORDER BY array_position(ix.indkey::int[], a.attnum)) FILTER (WHERE a.attname IS NOT NULL) as columns,
          ix.indisunique as is_unique,
          am.amname as type,
          pg_size_pretty(pg_relation_size(i.oid)) as size,
          pg_get_indexdef(ix.indexrelid) as definition
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_am am ON am.oid = i.relam
        LEFT JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ANY(ix.indkey::int[])
        WHERE ix.indrelid = $1
        GROUP BY i.relname, ix.indisunique, am.amname, i.oid, ix.indexrelid
        ORDER BY i.relname
      `, [oid]);
      indexes = idxResult.rows;

      // Triggers
      const trigResult = await pool.query(`
        SELECT
          t.tgname as name,
          CASE
            WHEN t.tgtype & 4 > 0 THEN 'INSERT'
            WHEN t.tgtype & 8 > 0 THEN 'DELETE'
            WHEN t.tgtype & 16 > 0 THEN 'UPDATE'
            ELSE 'UNKNOWN'
          END as event,
          CASE WHEN t.tgtype & 2 > 0 THEN 'BEFORE' ELSE 'AFTER' END as timing,
          p.proname as function_name,
          pg_get_triggerdef(t.oid) as definition
        FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = $1 AND NOT t.tgisinternal
        ORDER BY t.tgname
      `, [oid]);
      triggers = trigResult.rows;
    }

    // View definition and dependencies
    let definition: string | null = null;
    let dependencies: string[] | null = null;

    if (isView) {
      const defResult = await pool.query(`
        SELECT pg_get_viewdef($1::oid, true) as definition
      `, [oid]);
      definition = defResult.rows[0]?.definition || null;

      const depResult = await pool.query(`
        SELECT DISTINCT
          dc.relname as name
        FROM pg_depend d
        JOIN pg_rewrite r ON r.oid = d.objid
        JOIN pg_class dc ON dc.oid = d.refobjid
        WHERE r.ev_class = $1
          AND d.deptype = 'n'
          AND dc.relkind IN ('r', 'v')
          AND dc.relname != $2
        ORDER BY dc.relname
      `, [oid, table]);
      dependencies = depResult.rows.map(r => r.name);
    }

    return {
      name: table,
      type: isView ? 'view' : 'table',
      schema,
      oid,
      row_estimate: base.row_estimate,
      size: base.size,
      tablespace: base.tablespace || 'pg_default',
      has_rls: base.has_rls,
      comment: base.comment,
      columns: colResult.rows,
      constraints,
      foreign_keys: foreignKeys,
      indexes,
      triggers,
      definition,
      dependencies,
    };
  }

  async getTableData(
    schema: string,
    table: string,
    options?: { limit?: number; offset?: number; sort?: string; order?: string; where?: string }
  ): Promise<QueryResult> {
    const limit = options?.limit || 200;
    const offset = options?.offset || 0;
    // Sanitize sort column against injection
    const sort = options?.sort ? options.sort.replace(/[^a-zA-Z0-9_]/g, '') : null;
    const order = options?.order === 'desc' ? 'DESC' : 'ASC';

    const safeSchema = schema.replace(/"/g, '""');
    const safeTable = table.replace(/"/g, '""');
    let sql = `SELECT * FROM "${safeSchema}"."${safeTable}"`;
    if (options?.where) {
      sql += ` WHERE ${options.where}`;
    }
    if (sort) {
      sql += ` ORDER BY "${sort}" ${order}`;
    }
    sql += ` LIMIT ${limit} OFFSET ${offset}`;

    return this.executeQuery(sql, { maxRows: limit });
  }

  async executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult> {
    const pool = this.getPool();
    const queryId = options?.queryId || randomUUID();
    const timeout = options?.timeout || this.statementTimeout;
    const maxRows = options?.maxRows || 1000;

    const client = await pool.connect();
    this.activeQueries.set(queryId, client);

    const start = Date.now();
    try {
      // Set statement timeout for this session
      await client.query(`SET statement_timeout = ${timeout}`);

      const result = await client.query(sql);
      const duration = Date.now() - start;

      const columns = (result.fields || []).map(f => ({
        name: f.name,
        type: PG_TYPE_MAP[f.dataTypeID] || `oid:${f.dataTypeID}`,
        type_oid: f.dataTypeID,
      }));

      const truncated = result.rows.length > maxRows;
      const rows = result.rows.slice(0, maxRows).map(row =>
        columns.map(col => row[col.name])
      );

      // Determine affected rows for DML
      let affectedRows: number | null = null;
      if (result.command && result.command !== 'SELECT') {
        affectedRows = result.rowCount;
      }

      return {
        columns,
        rows,
        rowCount: result.rows.length,
        duration,
        affectedRows,
        truncated,
        queryId,
      };
    } catch (err: any) {
      const duration = Date.now() - start;
      throw Object.assign(err, { duration, queryId });
    } finally {
      this.activeQueries.delete(queryId);
      client.release();
    }
  }

  async cancelQuery(queryId: string): Promise<void> {
    const client = this.activeQueries.get(queryId);
    if (!client) return;
    // pg cancellation via pg_cancel_backend
    try {
      const pool = this.getPool();
      const pidResult = await pool.query('SELECT pg_backend_pid()');
      // The client itself knows its PID
      await pool.query('SELECT pg_cancel_backend($1)', [
        (client as any).processID
      ]);
    } catch (err) {
      log.warn({ err, queryId }, 'Failed to cancel query');
    }
  }
}
