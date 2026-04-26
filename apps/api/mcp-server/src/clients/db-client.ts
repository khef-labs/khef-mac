import pg from "pg";

export class DbClient {
  private pool: pg.Pool | null = null;

  constructor() {
    const dbUrl = process.env.KHEF_DATABASE_URL;
    if (dbUrl) {
      this.pool = new pg.Pool({
        connectionString: dbUrl,
        max: 3,
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: 5000,
      });
    }
  }

  private ensurePool(): pg.Pool {
    if (!this.pool) {
      throw new Error(
        "KHEF_DATABASE_URL not configured. Add it to mcpServers.khef.env in ~/.claude.json"
      );
    }
    return this.pool;
  }

  private async executeQuery(
    schema: string,
    sql: string,
    params?: unknown[],
    limit?: number
  ): Promise<object> {
    const pool = this.ensurePool();
    const forbidden =
      /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY)\b/i;
    if (forbidden.test(sql)) {
      throw new Error(
        "Only read-only queries (SELECT, WITH, EXPLAIN) are allowed"
      );
    }
    const effectiveLimit = Math.min(limit || 100, 1000);
    const client = await pool.connect();
    try {
      await client.query("SET statement_timeout = 30000");
      await client.query(`SET search_path = ${schema}, public`);
      const result = await client.query(sql, params);
      const rows = result.rows.slice(0, effectiveLimit);
      return {
        rows,
        row_count: rows.length,
        total_rows: result.rowCount,
        fields: result.fields.map((f) => ({
          name: f.name,
          dataTypeID: f.dataTypeID,
        })),
      };
    } finally {
      client.release();
    }
  }

  async queryKhef(sql: string, params?: unknown[], limit?: number) {
    return this.executeQuery("public", sql, params, limit);
  }

  async queryKvec(sql: string, params?: unknown[], limit?: number) {
    return this.executeQuery("kvec", sql, params, limit);
  }

  async queryKdag(sql: string, params?: unknown[], limit?: number) {
    return this.executeQuery("kdag", sql, params, limit);
  }

  async listTables(schema?: string): Promise<object> {
    const pool = this.ensurePool();
    const schemas = schema ? [schema] : ["public", "kvec", "kdag"];
    const result = await pool.query(
      `SELECT t.table_schema, t.table_name, t.table_type,
              pg_stat.n_live_tup AS estimated_rows
       FROM information_schema.tables t
       LEFT JOIN pg_stat_user_tables pg_stat
         ON pg_stat.schemaname = t.table_schema AND pg_stat.relname = t.table_name
       WHERE t.table_schema = ANY($1)
       ORDER BY t.table_schema, t.table_name`,
      [schemas]
    );
    return { tables: result.rows };
  }

  async describeTable(tableName: string, schema?: string): Promise<object> {
    const pool = this.ensurePool();
    const s = schema || "public";
    const [columns, constraints, indexes] = await Promise.all([
      pool.query(
        `SELECT column_name, data_type, udt_name, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [s, tableName]
      ),
      pool.query(
        `SELECT tc.constraint_name, tc.constraint_type, kcu.column_name,
                ccu.table_schema AS fk_schema, ccu.table_name AS fk_table,
                ccu.column_name AS fk_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
         LEFT JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name
           AND tc.table_schema = ccu.table_schema
         WHERE tc.table_schema = $1 AND tc.table_name = $2`,
        [s, tableName]
      ),
      pool.query(
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2`,
        [s, tableName]
      ),
    ]);
    return {
      schema: s,
      table: tableName,
      columns: columns.rows,
      constraints: constraints.rows,
      indexes: indexes.rows,
    };
  }
}
