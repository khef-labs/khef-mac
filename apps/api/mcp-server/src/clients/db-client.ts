import pg from "pg";

type Target = "dev" | "test";

/**
 * Default test DB DSN follows the project's docker-compose.test.yml: an
 * ephemeral tmpfs Postgres bound to localhost:5433 with database `khef_test`.
 * Override via KHEF_TEST_DATABASE_URL if your local setup differs.
 */
const DEFAULT_TEST_DSN = "postgresql://postgres@localhost:5433/khef_test";

export class DbClient {
  private devPool: pg.Pool | null = null;
  private testPool: pg.Pool | null = null;

  constructor() {
    const devUrl = process.env.KHEF_DATABASE_URL;
    if (devUrl) {
      this.devPool = new pg.Pool({
        connectionString: devUrl,
        max: 3,
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: 5000,
      });
    }

    const testUrl = process.env.KHEF_TEST_DATABASE_URL || DEFAULT_TEST_DSN;
    this.testPool = new pg.Pool({
      connectionString: testUrl,
      max: 2,
      idleTimeoutMillis: 60000,
      connectionTimeoutMillis: 5000,
    });
  }

  private ensurePool(target: Target): pg.Pool {
    if (target === "test") {
      if (!this.testPool) {
        throw new Error(
          "Test DB pool not configured. Set KHEF_TEST_DATABASE_URL in mcpServers.khef.env."
        );
      }
      return this.testPool;
    }
    if (!this.devPool) {
      throw new Error(
        "KHEF_DATABASE_URL not configured. Add it to mcpServers.khef.env in ~/.claude.json"
      );
    }
    return this.devPool;
  }

  private async executeQuery(
    target: Target,
    schema: string,
    sql: string,
    params?: unknown[],
    limit?: number
  ): Promise<object> {
    const pool = this.ensurePool(target);
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
    return this.executeQuery("dev", "public", sql, params, limit);
  }

  async queryKvec(sql: string, params?: unknown[], limit?: number) {
    return this.executeQuery("dev", "kvec", sql, params, limit);
  }

  async queryKdag(sql: string, params?: unknown[], limit?: number) {
    return this.executeQuery("dev", "kdag", sql, params, limit);
  }

  async queryTestDb(
    sql: string,
    params?: unknown[],
    limit?: number,
    schema?: "public" | "kvec" | "kdag"
  ) {
    return this.executeQuery("test", schema || "public", sql, params, limit);
  }

  async listTables(target: Target, schema?: string): Promise<object> {
    const pool = this.ensurePool(target);
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

  async describeTable(
    target: Target,
    tableName: string,
    schema?: string
  ): Promise<object> {
    const pool = this.ensurePool(target);
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
