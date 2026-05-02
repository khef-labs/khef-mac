/**
 * Database Explorer (dbx) routes.
 * Prefix: /api/dbx
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query, querySingle } from '../db/client';
import { saveSnapshot } from '../services/snapshots';
import { getDriver, removeDriver } from '../services/dbx/connection-manager';
import { encrypt, decrypt, isEncrypted } from '../services/dbx/crypto';
import type { DbxConnection } from '../services/dbx/drivers/types';
import { bindNamedParams, ParamBindError, type ParamDecl } from '../services/dbx/sql-params';
import { logger } from '../lib/logger';

const log = logger.child({ component: 'dbx-routes' });

// ──────────────────────── Builtin sync ──────────────────────────

/** Sync the builtin khef connection config from DATABASE_URL on startup */
async function syncBuiltinConnection(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return;
  try {
    const url = new URL(dbUrl);
    const config = {
      host: url.hostname || 'localhost',
      port: parseInt(url.port, 10) || 5432,
      database: url.pathname.replace(/^\//, '') || 'khef',
    };
    const credentials = url.username ? {
      username: decodeURIComponent(url.username),
      password: url.password ? decodeURIComponent(url.password) : undefined,
    } : null;
    const encCreds = encryptCredentials(credentials);
    await query(
      `UPDATE dbx.connections SET config = $1, credentials = $2 WHERE is_builtin = true AND driver = 'postgres'`,
      [JSON.stringify(config), encCreds]
    );
  } catch (err) {
    log.warn({ err }, 'Failed to sync builtin connection from DATABASE_URL');
  }
}

// ──────────────────────────── Helpers ────────────────────────────

/** Encrypt credentials before storing in DB */
function encryptCredentials(creds: Record<string, any> | null): string | null {
  if (!creds) return null;
  return encrypt(creds);
}

/** Decrypt credentials from DB. Returns decrypted object or null. */
function decryptCredentials(raw: any): Record<string, any> | null {
  if (!raw) return null;
  // If it's a string (encrypted), decrypt it
  if (typeof raw === 'string') {
    return isEncrypted(raw) ? decrypt(raw) : null;
  }
  // If it's already an object (legacy unencrypted or from builtin sync), return as-is
  if (typeof raw === 'object') return raw;
  return null;
}

/** Load a connection and decrypt its credentials */
async function getConnection(id: string): Promise<DbxConnection | null> {
  const rows = await query<DbxConnection>(
    'SELECT * FROM dbx.connections WHERE id = $1',
    [id]
  );
  if (!rows[0]) return null;
  rows[0].credentials = decryptCredentials(rows[0].credentials);
  return rows[0];
}

async function getBuiltinConnection(): Promise<DbxConnection | null> {
  const rows = await query<DbxConnection>(
    "SELECT * FROM dbx.connections WHERE is_builtin = true AND driver = 'postgres' LIMIT 1"
  );
  if (!rows[0]) return null;
  rows[0].credentials = decryptCredentials(rows[0].credentials);
  return rows[0];
}

async function requireConnection(id: string, reply: FastifyReply): Promise<DbxConnection | null> {
  const conn = await getConnection(id);
  if (!conn) {
    reply.code(404).send({ error: 'Connection not found' });
    return null;
  }
  return conn;
}

const HISTORY_CAP = 500;

/**
 * Insert a snapshot of a saved query's current SQL + params. Returns the
 * assigned snapshot_number (monotonically increasing per query). Used by the
 * manual snapshot endpoint and as a pre-restore safety net.
 */
async function captureSavedQuerySnapshot(
  queryId: string,
  source: 'manual' | 'pre-restore',
  editedBy: string | null,
): Promise<{ snapshot_number: number } | null> {
  const queryRow = await querySingle<{ sql: string }>(
    'SELECT sql FROM dbx.saved_queries WHERE id = $1',
    [queryId]
  );
  if (!queryRow) return null;

  const paramRows = await query(
    'SELECT * FROM dbx.saved_query_params WHERE query_id = $1 ORDER BY sort_order, name',
    [queryId]
  );

  const next = await querySingle<{ next: number }>(
    `SELECT COALESCE(MAX(snapshot_number), 0) + 1 AS next
     FROM dbx.saved_query_snapshots WHERE query_id = $1`,
    [queryId]
  );
  const snapshotNumber = next?.next ?? 1;

  await query(
    `INSERT INTO dbx.saved_query_snapshots
       (query_id, snapshot_number, sql, params_snapshot, edited_by, source)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      queryId,
      snapshotNumber,
      queryRow.sql,
      JSON.stringify(paramRows),
      editedBy,
      source,
    ]
  );

  return { snapshot_number: snapshotNumber };
}

async function recordHistory(
  connectionId: string,
  sql: string,
  rowCount: number | null,
  durationMs: number | null,
  error: string | null,
  extra?: {
    queryId?: string | null;
    sessionId?: string | null;
    paramsSnapshot?: Record<string, unknown> | null;
    status?: 'success' | 'error' | 'canceled';
  }
): Promise<void> {
  try {
    const status = extra?.status ?? (error ? 'error' : 'success');
    await query(
      `INSERT INTO dbx.query_history
         (connection_id, sql, row_count, duration_ms, error, query_id, session_id, params_snapshot, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        connectionId,
        sql,
        rowCount,
        durationMs,
        error,
        extra?.queryId ?? null,
        extra?.sessionId ?? null,
        extra?.paramsSnapshot ? JSON.stringify(extra.paramsSnapshot) : null,
        status,
      ]
    );
    // Prune old entries beyond cap
    await query(
      `DELETE FROM dbx.query_history
       WHERE connection_id = $1
         AND id NOT IN (
           SELECT id FROM dbx.query_history
           WHERE connection_id = $1
           ORDER BY created_at DESC
           LIMIT $2
         )`,
      [connectionId, HISTORY_CAP]
    );
  } catch (err) {
    log.warn({ err }, 'Failed to record query history');
  }
}

// ──────────────────────────── Routes ────────────────────────────

export default async function dbxRoutes(fastify: FastifyInstance) {

  // Sync builtin connection config from DATABASE_URL on registration
  syncBuiltinConnection().catch(() => {});

  // ── Connections CRUD ──

  fastify.get('/connections', async (_req, reply) => {
    // Never return credentials to the client
    const rows = await query(
      'SELECT id, name, driver, config, is_builtin, options, created_at, updated_at FROM dbx.connections ORDER BY is_builtin DESC, name'
    );
    return { connections: rows };
  });

  fastify.post('/connections', async (req: FastifyRequest<{
    Body: { name: string; driver: string; config: Record<string, any>; credentials?: Record<string, any>; options?: Record<string, any> }
  }>, reply) => {
    const { name, driver, config, credentials, options } = req.body;
    if (!name || !driver) {
      return reply.code(400).send({ error: 'name and driver are required' });
    }
    const encCreds = encryptCredentials(credentials || null);
    const rows = await query(
      `INSERT INTO dbx.connections (name, driver, config, credentials, options)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, driver, config, is_builtin, options, created_at, updated_at`,
      [name, driver, JSON.stringify(config), encCreds, JSON.stringify(options || {})]
    );
    return reply.code(201).send({ connection: rows[0] });
  });

  fastify.patch('/connections/:id', async (req: FastifyRequest<{
    Params: { id: string };
    Body: { name?: string; config?: Record<string, any>; credentials?: Record<string, any>; options?: Record<string, any> }
  }>, reply) => {
    const conn = await requireConnection(req.params.id, reply);
    if (!conn) return;

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (req.body.name !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(req.body.name);
    }
    if (req.body.config !== undefined) {
      updates.push(`config = $${idx++}`);
      values.push(JSON.stringify(req.body.config));
    }
    if (req.body.credentials !== undefined) {
      updates.push(`credentials = $${idx++}`);
      values.push(encryptCredentials(req.body.credentials || null));
    }
    if (req.body.options !== undefined) {
      updates.push(`options = $${idx++}`);
      values.push(JSON.stringify(req.body.options));
    }

    if (updates.length === 0) {
      return reply.code(400).send({ error: 'No fields to update' });
    }

    values.push(req.params.id);
    const rows = await query(
      `UPDATE dbx.connections SET ${updates.join(', ')} WHERE id = $${idx}
       RETURNING id, name, driver, config, is_builtin, options, created_at, updated_at`,
      values
    );

    // Disconnect cached driver so next use picks up new config
    await removeDriver(req.params.id);

    return { connection: rows[0] };
  });

  fastify.delete('/connections/:id', async (req: FastifyRequest<{
    Params: { id: string }
  }>, reply) => {
    const conn = await requireConnection(req.params.id, reply);
    if (!conn) return;

    if (conn.is_builtin) {
      return reply.code(400).send({ error: 'Cannot delete builtin connection' });
    }

    await removeDriver(req.params.id);
    await query('DELETE FROM dbx.connections WHERE id = $1', [req.params.id]);
    return reply.code(204).send();
  });

  // ── Connection test ──

  fastify.post('/connections/:id/test', async (req: FastifyRequest<{
    Params: { id: string }
  }>, reply) => {
    const conn = await requireConnection(req.params.id, reply);
    if (!conn) return;

    const driver = await getDriver(conn);
    const result = await driver.testConnection();
    return result;
  });

  // Test before saving (no connection ID yet)
  fastify.post('/connections/test', async (req: FastifyRequest<{
    Body: { driver: string; config: Record<string, any>; credentials?: Record<string, any>; options?: Record<string, any> }
  }>, reply) => {
    const fakeConn: DbxConnection = {
      id: 'test',
      name: 'test',
      driver: req.body.driver,
      config: req.body.config,
      credentials: req.body.credentials || null,
      is_builtin: false,
      options: req.body.options || {},
      created_at: '',
      updated_at: '',
    };
    try {
      const { PostgresDriver } = await import('../services/dbx/drivers/postgres');
      const driver = new PostgresDriver(fakeConn.config, fakeConn.credentials, fakeConn.options);
      const result = await driver.testConnection();
      return result;
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  // ── Connection overview ──

  fastify.get('/connections/:id/overview', async (req: FastifyRequest<{
    Params: { id: string }
  }>, reply) => {
    const conn = await requireConnection(req.params.id, reply);
    if (!conn) return;

    const driver = await getDriver(conn);
    return await driver.getOverview();
  });

  // ── Schema introspection ──

  fastify.get('/connections/:id/schemas', async (req: FastifyRequest<{
    Params: { id: string }
  }>, reply) => {
    const conn = await requireConnection(req.params.id, reply);
    if (!conn) return;

    const driver = await getDriver(conn);
    const schemas = await driver.getSchemas();
    return { schemas };
  });

  fastify.get('/connections/:id/schemas/:schema/tables', async (req: FastifyRequest<{
    Params: { id: string; schema: string }
  }>, reply) => {
    const conn = await requireConnection(req.params.id, reply);
    if (!conn) return;

    const driver = await getDriver(conn);
    const tables = await driver.getTables(req.params.schema);
    return { tables };
  });

  fastify.get('/connections/:id/schemas/:schema/tables/:table', async (req: FastifyRequest<{
    Params: { id: string; schema: string; table: string }
  }>, reply) => {
    const conn = await requireConnection(req.params.id, reply);
    if (!conn) return;

    const driver = await getDriver(conn);
    try {
      const detail = await driver.describeTable(req.params.schema, req.params.table);
      return { table: detail };
    } catch (err: any) {
      return reply.code(404).send({ error: err.message });
    }
  });

  // ── Functions ──

  fastify.get('/connections/:id/schemas/:schema/functions', async (req: FastifyRequest<{
    Params: { id: string; schema: string }
  }>, reply) => {
    const conn = await requireConnection(req.params.id, reply);
    if (!conn) return;
    const driver = await getDriver(conn);
    const functions = await driver.getFunctions(req.params.schema);
    return { functions };
  });

  fastify.get('/connections/:id/schemas/:schema/functions/:name', async (req: FastifyRequest<{
    Params: { id: string; schema: string; name: string };
    Querystring: { args?: string }
  }>, reply) => {
    const conn = await requireConnection(req.params.id, reply);
    if (!conn) return;
    const driver = await getDriver(conn);
    try {
      const fn = await driver.getFunctionDetail(req.params.schema, req.params.name, req.query.args || undefined);
      return { function: fn };
    } catch (err: any) {
      return reply.code(404).send({ error: err.message });
    }
  });

  // ── Schema-level triggers ──

  fastify.get('/connections/:id/schemas/:schema/triggers', async (req: FastifyRequest<{
    Params: { id: string; schema: string }
  }>, reply) => {
    const conn = await requireConnection(req.params.id, reply);
    if (!conn) return;
    const driver = await getDriver(conn);
    const triggers = await driver.getSchemaTriggers(req.params.schema);
    return { triggers };
  });

  // ── Table data ──

  fastify.get('/connections/:id/schemas/:schema/tables/:table/data', async (req: FastifyRequest<{
    Params: { id: string; schema: string; table: string };
    Querystring: { limit?: string; offset?: string; sort?: string; order?: string; where?: string }
  }>, reply) => {
    const conn = await requireConnection(req.params.id, reply);
    if (!conn) return;

    const driver = await getDriver(conn);
    try {
      const result = await driver.getTableData(req.params.schema, req.params.table, {
        limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
        offset: req.query.offset ? parseInt(req.query.offset, 10) : undefined,
        sort: req.query.sort,
        order: req.query.order,
        where: req.query.where || undefined,
      });
      return result;
    } catch (err: any) {
      return reply.code(400).send({ error: err.message || 'Query failed' });
    }
  });

  // ── ERD generation ──

  // Schema-level ERD: all tables in the schema with their FK relationships
  fastify.get('/connections/:id/schemas/:schema/erd', async (req: FastifyRequest<{
    Params: { id: string; schema: string };
    Querystring: { compact?: string }
  }>, reply) => {
    const conn = await requireConnection(req.params.id, reply);
    if (!conn) return;

    const { schema } = req.params;
    const compact = req.query.compact === 'true';
    const driver = await getDriver(conn);

    try {
      const tables = await driver.getTables(schema);
      const tableNames = tables.filter(t => t.type === 'table').map(t => t.name);

      // Fetch detail for all tables
      const details: Record<string, any> = {};
      for (const name of tableNames) {
        try {
          details[name] = await driver.describeTable(schema, name);
        } catch {
          // Skip tables we can't describe
        }
      }

      // If compact, strip columns down to PK/FK only
      if (compact) {
        for (const [, detail] of Object.entries(details)) {
          const pkCols = new Set<string>();
          const fkCols = new Set<string>();
          for (const c of (detail as any).constraints) {
            if (c.type === 'PRIMARY KEY') {
              const cols = Array.isArray(c.columns) ? c.columns : c.columns.replace(/[{}]/g, '').split(',').map((s: string) => s.trim());
              cols.forEach((col: string) => pkCols.add(col));
            }
          }
          for (const fk of (detail as any).foreign_keys) {
            const cols = Array.isArray(fk.columns) ? fk.columns : fk.columns.replace(/[{}]/g, '').split(',').map((s: string) => s.trim());
            cols.forEach((col: string) => fkCols.add(col));
          }
          (detail as any).columns = (detail as any).columns.filter((col: any) => pkCols.has(col.name) || fkCols.has(col.name));
        }
      }

      return {
        schema,
        tables: details,
        table_count: Object.keys(details).length,
      };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  fastify.get('/connections/:id/schemas/:schema/tables/:table/erd', async (req: FastifyRequest<{
    Params: { id: string; schema: string; table: string };
    Querystring: { depth?: string }
  }>, reply) => {
    const conn = await requireConnection(req.params.id, reply);
    if (!conn) return;

    const { schema, table } = req.params;
    const driver = await getDriver(conn);

    try {
      // Get the focused table detail
      const focusedDetail = await driver.describeTable(schema, table);

      // Collect related table names from outgoing FKs
      const relatedTables = new Map<string, { schema: string; table: string }>();
      for (const fk of focusedDetail.foreign_keys) {
        const key = `${fk.referenced_schema}.${fk.referenced_table}`;
        if (key !== `${schema}.${table}`) {
          relatedTables.set(key, { schema: fk.referenced_schema, table: fk.referenced_table });
        }
      }

      // Find reverse FKs (tables that reference this table) via pg_catalog
      // Note: executeQuery doesn't support parameterized queries, so we use escaped literals
      const esc = (s: string) => s.replace(/'/g, "''");
      const reverseFks = await driver.executeQuery(`
        SELECT
          n.nspname AS source_schema,
          c.relname AS source_table,
          a.attname AS source_column,
          af.attname AS target_column
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_class cf ON cf.oid = con.confrelid
        JOIN pg_namespace nf ON nf.oid = cf.relnamespace
        CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        CROSS JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS kf(attnum, ord)
        JOIN pg_attribute af ON af.attrelid = con.confrelid AND af.attnum = kf.attnum AND kf.ord = k.ord
        WHERE con.contype = 'f'
          AND nf.nspname = '${esc(schema)}'
          AND cf.relname = '${esc(table)}'
          AND NOT (n.nspname = '${esc(schema)}' AND c.relname = '${esc(table)}')
      `, { maxRows: 500, timeout: 10000 });

      // Add reverse FK tables to related set
      for (const row of reverseFks.rows) {
        const key = `${row[0]}.${row[1]}`;
        if (!relatedTables.has(key)) {
          relatedTables.set(key, { schema: row[0] as string, table: row[1] as string });
        }
      }

      // Fetch details for all related tables
      const relatedDetails: Record<string, typeof focusedDetail> = {};
      for (const [key, ref] of relatedTables) {
        try {
          relatedDetails[key] = await driver.describeTable(ref.schema, ref.table);
        } catch {
          // Skip tables we can't describe (permissions, etc.)
        }
      }

      return {
        focused: focusedDetail,
        related: relatedDetails,
        reverse_fks: reverseFks.rows.map(r => ({
          source_schema: r[0],
          source_table: r[1],
          source_column: r[2],
          target_column: r[3],
        })),
      };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── Query execution ──

  fastify.post('/connections/:id/query', async (req: FastifyRequest<{
    Params: { id: string };
    Body: { sql: string; timeout?: number; maxRows?: number }
  }>, reply) => {
    const conn = await requireConnection(req.params.id, reply);
    if (!conn) return;

    const { sql, timeout, maxRows } = req.body;
    if (!sql?.trim()) {
      return reply.code(400).send({ error: 'sql is required' });
    }

    const driver = await getDriver(conn);
    try {
      const result = await driver.executeQuery(sql, { timeout, maxRows });
      // Record success
      recordHistory(conn.id, sql, result.rowCount, result.duration, null);
      return result;
    } catch (err: any) {
      const duration = err.duration || 0;
      const errorMsg = err.message || 'Query failed';
      recordHistory(conn.id, sql, null, duration, errorMsg);
      return reply.code(400).send({
        error: errorMsg,
        duration,
        queryId: err.queryId,
      });
    }
  });

  fastify.post('/connections/:id/query/cancel', async (req: FastifyRequest<{
    Params: { id: string };
    Body: { queryId: string }
  }>, reply) => {
    const conn = await requireConnection(req.params.id, reply);
    if (!conn) return;

    const driver = await getDriver(conn);
    await driver.cancelQuery(req.body.queryId);
    return { cancelled: true };
  });

  // ── Scripts CRUD ──

  fastify.get('/scripts', async (req: FastifyRequest<{
    Querystring: { connection_id?: string }
  }>, _reply) => {
    let sql = 'SELECT * FROM dbx.scripts';
    const params: any[] = [];

    if (req.query.connection_id) {
      sql += ' WHERE connection_id = $1';
      params.push(req.query.connection_id);
    }

    sql += ' ORDER BY updated_at DESC';
    const rows = await query(sql, params);
    return { scripts: rows };
  });

  fastify.get('/scripts/:id', async (req: FastifyRequest<{
    Params: { id: string }
  }>, reply) => {
    const row = await querySingle('SELECT * FROM dbx.scripts WHERE id = $1', [req.params.id]);
    if (!row) return reply.code(404).send({ error: 'Script not found' });
    return { script: row };
  });

  fastify.post('/scripts', async (req: FastifyRequest<{
    Body: { name: string; content?: string; connection_id?: string }
  }>, reply) => {
    const { name, content, connection_id } = req.body;
    if (!name) return reply.code(400).send({ error: 'name is required' });

    const rows = await query(
      `INSERT INTO dbx.scripts (name, content, connection_id)
       VALUES ($1, $2, $3) RETURNING *`,
      [name, content || '', connection_id || null]
    );
    return reply.code(201).send({ script: rows[0] });
  });

  fastify.patch('/scripts/:id', async (req: FastifyRequest<{
    Params: { id: string };
    Body: { name?: string; content?: string; connection_id?: string }
  }>, reply) => {
    const existing = await querySingle('SELECT id FROM dbx.scripts WHERE id = $1', [req.params.id]);
    if (!existing) return reply.code(404).send({ error: 'Script not found' });

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (req.body.name !== undefined) { updates.push(`name = $${idx++}`); values.push(req.body.name); }
    if (req.body.content !== undefined) { updates.push(`content = $${idx++}`); values.push(req.body.content); }
    if (req.body.connection_id !== undefined) { updates.push(`connection_id = $${idx++}`); values.push(req.body.connection_id || null); }

    if (updates.length === 0) return reply.code(400).send({ error: 'No fields to update' });

    values.push(req.params.id);
    const rows = await query(
      `UPDATE dbx.scripts SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return { script: rows[0] };
  });

  fastify.delete('/scripts/:id', async (req: FastifyRequest<{
    Params: { id: string }
  }>, reply) => {
    const existing = await querySingle('SELECT id FROM dbx.scripts WHERE id = $1', [req.params.id]);
    if (!existing) return reply.code(404).send({ error: 'Script not found' });
    await query('DELETE FROM dbx.scripts WHERE id = $1', [req.params.id]);
    return reply.code(204).send();
  });

  // ── Saved Queries CRUD ──

  fastify.get('/saved-queries', async (req: FastifyRequest<{
    Querystring: {
      connection_id?: string;
      session_id?: string;
      favorite?: string;
      shared?: string;
      q?: string;
      limit?: string;
      offset?: string;
    }
  }>, _reply) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);

    const where: string[] = [];
    const values: any[] = [];

    if (req.query.connection_id) {
      where.push(`q.connection_id = $${values.length + 1}`);
      values.push(req.query.connection_id);
    }
    if (req.query.shared === 'true') where.push('q.is_shared = true');
    if (req.query.q) {
      const i = values.length + 1;
      where.push(`(q.name ILIKE $${i} OR q.description ILIKE $${i} OR q.handle ILIKE $${i})`);
      values.push(`%${req.query.q}%`);
    }

    let joinFav = '';
    let favCol = ', false AS is_favorite';
    if (req.query.session_id) {
      const i = values.length + 1;
      const kind = req.query.favorite === 'true' ? 'INNER' : 'LEFT';
      joinFav = `${kind} JOIN dbx.saved_query_favorites f ON f.query_id = q.id AND f.session_id = $${i}`;
      favCol = ', f.session_id IS NOT NULL AS is_favorite';
      values.push(req.query.session_id);
    } else if (req.query.favorite === 'true') {
      where.push('false');
    }

    const sqlText = `
      SELECT q.*${favCol}
      FROM dbx.saved_queries q
      ${joinFav}
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY q.updated_at DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}
    `;
    values.push(limit, offset);

    const rows = await query(sqlText, values);
    return { saved_queries: rows };
  });

  fastify.get('/saved-queries/recent', async (req: FastifyRequest<{
    Querystring: { session_id: string; limit?: string }
  }>, reply) => {
    if (!req.query.session_id) {
      return reply.code(400).send({ error: 'session_id is required' });
    }
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    const rows = await query(
      `SELECT DISTINCT ON (h.query_id)
              h.query_id,
              h.created_at AS last_run_at,
              q.name, q.handle, q.connection_id, q.schema_scope,
              c.name AS connection_name
       FROM dbx.query_history h
       INNER JOIN dbx.saved_queries q ON q.id = h.query_id
       LEFT JOIN dbx.connections c ON c.id = q.connection_id
       WHERE h.session_id = $1
         AND h.query_id IS NOT NULL
         AND h.created_at > NOW() - INTERVAL '7 days'
       ORDER BY h.query_id, h.created_at DESC
       LIMIT $2`,
      [req.query.session_id, limit]
    );
    return { recent: rows };
  });

  fastify.get('/saved-queries/:id', async (req: FastifyRequest<{
    Params: { id: string };
    Querystring: { session_id?: string }
  }>, reply) => {
    const queryRow = await querySingle<any>(
      'SELECT * FROM dbx.saved_queries WHERE id = $1',
      [req.params.id]
    );
    if (!queryRow) return reply.code(404).send({ error: 'Saved query not found' });

    const params = await query(
      'SELECT * FROM dbx.saved_query_params WHERE query_id = $1 ORDER BY sort_order, name',
      [req.params.id]
    );

    let isFavorite = false;
    if (req.query.session_id) {
      const fav = await querySingle(
        'SELECT 1 FROM dbx.saved_query_favorites WHERE query_id = $1 AND session_id = $2',
        [req.params.id, req.query.session_id]
      );
      isFavorite = !!fav;
    }

    return { saved_query: { ...queryRow, params, is_favorite: isFavorite } };
  });

  fastify.post('/saved-queries', async (req: FastifyRequest<{
    Body: {
      connection_id?: string | null;
      name: string;
      handle: string;
      description?: string;
      sql?: string;
      schema_scope?: string;
      is_shared?: boolean;
      is_readonly?: boolean;
      owner_session_id?: string;
      params?: Array<{
        name: string;
        value_type?: 'text'|'number'|'bool'|'enum';
        required?: boolean;
        default_value?: string;
        options?: string[];
        sort_order?: number;
      }>;
    }
  }>, reply) => {
    const b = req.body;
    if (!b.name || !b.handle) {
      return reply.code(400).send({ error: 'name and handle are required' });
    }
    if (!b.connection_id) {
      return reply.code(400).send({ error: 'connection_id is required' });
    }
    // owner_session_id is required for API-created queries. The only path
    // that legitimately produces null-owner rows is the seed file
    // (apps/api/db/seed/seeds/dbx_saved_queries.sql); enforcing this here
    // means "owner IS NULL" reliably means "built-in / seed-installed".
    if (!b.owner_session_id) {
      return reply.code(400).send({ error: 'owner_session_id is required (pass your session id or nickname)' });
    }

    // is_readonly is no longer a user-facing toggle: it's strictly derived
    // from ownership. Built-in (no owner) → true; user-owned → false. The
    // executor still consumes the column to wrap runs in BEGIN READ ONLY.
    const ownerSessionId = b.owner_session_id;
    const isReadonly = false;

    try {
      const queryRow = await querySingle<any>(
        `INSERT INTO dbx.saved_queries
           (connection_id, name, handle, description, sql, schema_scope, is_shared, is_readonly, owner_session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          b.connection_id,
          b.name,
          b.handle,
          b.description || null,
          b.sql || '',
          b.schema_scope || null,
          b.is_shared ?? false,
          isReadonly,
          ownerSessionId,
        ]
      );

      const paramRows: any[] = [];
      if (b.params && b.params.length > 0) {
        for (let i = 0; i < b.params.length; i++) {
          const p = b.params[i];
          const row = await querySingle(
            `INSERT INTO dbx.saved_query_params
               (query_id, name, value_type, required, default_value, options, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
              queryRow!.id,
              p.name,
              p.value_type || 'text',
              p.required ?? false,
              p.default_value || null,
              p.options ? JSON.stringify(p.options) : null,
              p.sort_order ?? i,
            ]
          );
          paramRows.push(row);
        }
      }

      return reply.code(201).send({ saved_query: { ...queryRow, params: paramRows } });
    } catch (err: any) {
      if (err.code === '23505') {
        return reply.code(409).send({ error: 'A saved query with that handle already exists for this connection' });
      }
      if (err.code === '23514') {
        return reply.code(400).send({ error: 'handle must be kebab-case (lowercase letters, digits, hyphens)' });
      }
      throw err;
    }
  });

  fastify.patch('/saved-queries/:id', async (req: FastifyRequest<{
    Params: { id: string };
    Body: {
      connection_id?: string | null;
      name?: string;
      handle?: string;
      description?: string;
      sql?: string;
      schema_scope?: string;
      is_shared?: boolean;
      is_readonly?: boolean;
      params?: Array<{
        name: string;
        value_type?: 'text'|'number'|'bool'|'enum';
        required?: boolean;
        default_value?: string;
        options?: string[];
        sort_order?: number;
      }>;
      edited_by?: string;
    }
  }>, reply) => {
    const existing = await querySingle<any>(
      'SELECT * FROM dbx.saved_queries WHERE id = $1',
      [req.params.id]
    );
    if (!existing) return reply.code(404).send({ error: 'Saved query not found' });

    const paramsChanged = req.body.params !== undefined;

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (req.body.connection_id !== undefined) {
      if (!req.body.connection_id) {
        return reply.code(400).send({ error: 'connection_id is required (saved queries must always be bound to a connection)' });
      }
      updates.push(`connection_id = $${idx++}`); values.push(req.body.connection_id);
    }
    if (req.body.name !== undefined) { updates.push(`name = $${idx++}`); values.push(req.body.name); }
    if (req.body.handle !== undefined) { updates.push(`handle = $${idx++}`); values.push(req.body.handle); }
    if (req.body.description !== undefined) { updates.push(`description = $${idx++}`); values.push(req.body.description || null); }
    if (req.body.sql !== undefined) { updates.push(`sql = $${idx++}`); values.push(req.body.sql); }
    if (req.body.schema_scope !== undefined) { updates.push(`schema_scope = $${idx++}`); values.push(req.body.schema_scope || null); }
    if (req.body.is_shared !== undefined) { updates.push(`is_shared = $${idx++}`); values.push(req.body.is_shared); }
    // is_readonly is derived from ownership and not user-settable via PATCH —
    // ignore the field if a client sends it.

    if (updates.length === 0 && !paramsChanged) {
      return reply.code(400).send({ error: 'No fields to update' });
    }

    let updated = existing;
    if (updates.length > 0) {
      values.push(req.params.id);
      try {
        const r = await query<any>(
          `UPDATE dbx.saved_queries SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
          values
        );
        updated = r[0];
      } catch (err: any) {
        if (err.code === '23505') {
          return reply.code(409).send({ error: 'A saved query with that handle already exists for this connection' });
        }
        if (err.code === '23514') {
          return reply.code(400).send({ error: 'handle must be kebab-case' });
        }
        throw err;
      }
    }

    let paramRows: any[];
    if (paramsChanged) {
      await query('DELETE FROM dbx.saved_query_params WHERE query_id = $1', [req.params.id]);
      paramRows = [];
      const list = req.body.params || [];
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        const row = await querySingle(
          `INSERT INTO dbx.saved_query_params
             (query_id, name, value_type, required, default_value, options, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            req.params.id,
            p.name,
            p.value_type || 'text',
            p.required ?? false,
            p.default_value || null,
            p.options ? JSON.stringify(p.options) : null,
            p.sort_order ?? i,
          ]
        );
        paramRows.push(row);
      }
    } else {
      paramRows = await query(
        'SELECT * FROM dbx.saved_query_params WHERE query_id = $1 ORDER BY sort_order, name',
        [req.params.id]
      );
    }

    return { saved_query: { ...updated, params: paramRows } };
  });

  fastify.delete('/saved-queries/:id', async (req: FastifyRequest<{
    Params: { id: string }
  }>, reply) => {
    const existing = await querySingle('SELECT id FROM dbx.saved_queries WHERE id = $1', [req.params.id]);
    if (!existing) return reply.code(404).send({ error: 'Saved query not found' });
    await query('DELETE FROM dbx.saved_queries WHERE id = $1', [req.params.id]);
    return reply.code(204).send();
  });

  fastify.post('/saved-queries/:id/favorite', async (req: FastifyRequest<{
    Params: { id: string };
    Body: { session_id: string }
  }>, reply) => {
    if (!req.body.session_id) return reply.code(400).send({ error: 'session_id is required' });
    const existing = await querySingle('SELECT id FROM dbx.saved_queries WHERE id = $1', [req.params.id]);
    if (!existing) return reply.code(404).send({ error: 'Saved query not found' });
    await query(
      `INSERT INTO dbx.saved_query_favorites (query_id, session_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, req.body.session_id]
    );
    return reply.code(204).send();
  });

  fastify.delete('/saved-queries/:id/favorite', async (req: FastifyRequest<{
    Params: { id: string };
    Querystring: { session_id: string }
  }>, reply) => {
    if (!req.query.session_id) return reply.code(400).send({ error: 'session_id is required' });
    await query(
      'DELETE FROM dbx.saved_query_favorites WHERE query_id = $1 AND session_id = $2',
      [req.params.id, req.query.session_id]
    );
    return reply.code(204).send();
  });

  // ── Run a saved query ──
  // Binds :name params via bindNamedParams, runs read-only against the
  // saved query's connection (or the builtin if connection_id is null), and
  // logs the run to dbx.query_history with query_id + session_id +
  // params_snapshot. is_readonly=false on the saved query opts out of the
  // read-only transaction wrapper.
  fastify.post('/saved-queries/:id/run', async (req: FastifyRequest<{
    Params: { id: string };
    Body: {
      params?: Record<string, unknown>;
      session_id?: string;
      timeout?: number;
      maxRows?: number;
    }
  }>, reply) => {
    const savedQuery = await querySingle<any>(
      'SELECT * FROM dbx.saved_queries WHERE id = $1',
      [req.params.id]
    );
    if (!savedQuery) return reply.code(404).send({ error: 'Saved query not found' });

    if (!savedQuery.sql || !savedQuery.sql.trim()) {
      return reply.code(400).send({ error: 'Saved query has no SQL to run' });
    }

    const declaredRows = await query<any>(
      'SELECT * FROM dbx.saved_query_params WHERE query_id = $1 ORDER BY sort_order, name',
      [req.params.id]
    );
    const declared: ParamDecl[] = declaredRows.map((r) => ({
      name: r.name,
      value_type: r.value_type,
      required: r.required,
      default_value: r.default_value,
      options: Array.isArray(r.options) ? r.options : null,
    }));

    let bound;
    try {
      bound = bindNamedParams(savedQuery.sql, declared, req.body.params || {});
    } catch (err) {
      if (err instanceof ParamBindError) {
        return reply.code(400).send({ error: err.message, field: err.field });
      }
      throw err;
    }

    // Resolve connection: explicit FK first, fall back to the builtin khef DB
    // for connection-agnostic saved queries.
    const conn = savedQuery.connection_id
      ? await getConnection(savedQuery.connection_id)
      : await getBuiltinConnection();
    if (!conn) {
      return reply.code(400).send({
        error: savedQuery.connection_id
          ? 'Connection no longer exists'
          : 'No builtin connection available to run connection-agnostic query',
      });
    }

    const driver = await getDriver(conn);
    const sessionId = req.body.session_id || null;

    try {
      const result = await driver.executeQuery(bound.sql, {
        timeout: req.body.timeout,
        maxRows: req.body.maxRows,
        params: bound.values,
        readOnly: savedQuery.is_readonly !== false,
      });
      recordHistory(conn.id, savedQuery.sql, result.rowCount, result.duration, null, {
        queryId: savedQuery.id,
        sessionId,
        paramsSnapshot: req.body.params || {},
        status: 'success',
      });
      return result;
    } catch (err: any) {
      const duration = err.duration || 0;
      const errorMsg = err.message || 'Query failed';
      recordHistory(conn.id, savedQuery.sql, null, duration, errorMsg, {
        queryId: savedQuery.id,
        sessionId,
        paramsSnapshot: req.body.params || {},
        status: 'error',
      });
      return reply.code(400).send({
        error: errorMsg,
        duration,
        queryId: err.queryId,
      });
    }
  });

  // ── Saved-query snapshots ──
  // Mirrors memory_snapshots semantics: editing the SQL is free, snapshots
  // are explicit point-in-time captures the user takes themselves. Restore
  // creates a `pre-restore` safety snapshot before overwriting the live SQL.

  fastify.get('/saved-queries/:id/snapshots', async (req: FastifyRequest<{
    Params: { id: string }
  }>, reply) => {
    const sq = await querySingle<{ current_snapshot: number | null }>(
      'SELECT current_snapshot FROM dbx.saved_queries WHERE id = $1',
      [req.params.id]
    );
    if (!sq) return reply.code(404).send({ error: 'Saved query not found' });
    const snapshots = await query(
      `SELECT id, snapshot_number, sql, params_snapshot, edited_by, source, edited_at
       FROM dbx.saved_query_snapshots
       WHERE query_id = $1
       ORDER BY snapshot_number DESC`,
      [req.params.id]
    );
    return { snapshots, current_snapshot: sq.current_snapshot };
  });

  fastify.get('/saved-queries/:id/snapshots/:num', async (req: FastifyRequest<{
    Params: { id: string; num: string }
  }>, reply) => {
    const num = parseInt(req.params.num, 10);
    if (!Number.isFinite(num)) return reply.code(400).send({ error: 'snapshot_number must be an integer' });
    const snapshot = await querySingle(
      `SELECT id, snapshot_number, sql, params_snapshot, edited_by, source, edited_at
       FROM dbx.saved_query_snapshots
       WHERE query_id = $1 AND snapshot_number = $2`,
      [req.params.id, num]
    );
    if (!snapshot) return reply.code(404).send({ error: 'Snapshot not found' });
    return { snapshot };
  });

  fastify.post('/saved-queries/:id/snapshots', async (req: FastifyRequest<{
    Params: { id: string };
    Body: { edited_by?: string }
  }>, reply) => {
    const exists = await querySingle('SELECT id FROM dbx.saved_queries WHERE id = $1', [req.params.id]);
    if (!exists) return reply.code(404).send({ error: 'Saved query not found' });
    const result = await captureSavedQuerySnapshot(req.params.id, 'manual', req.body.edited_by || null);
    if (!result) return reply.code(500).send({ error: 'Failed to capture snapshot' });
    // The newly captured snapshot matches the live SQL — point current there.
    await query(
      'UPDATE dbx.saved_queries SET current_snapshot = $1 WHERE id = $2',
      [result.snapshot_number, req.params.id]
    );
    return reply.code(201).send({ snapshot_number: result.snapshot_number, current_snapshot: result.snapshot_number });
  });

  fastify.post('/saved-queries/:id/snapshots/:num/restore', async (req: FastifyRequest<{
    Params: { id: string; num: string };
    Body: { edited_by?: string }
  }>, reply) => {
    const num = parseInt(req.params.num, 10);
    if (!Number.isFinite(num)) return reply.code(400).send({ error: 'snapshot_number must be an integer' });

    const snapshot = await querySingle<any>(
      `SELECT sql, params_snapshot FROM dbx.saved_query_snapshots
       WHERE query_id = $1 AND snapshot_number = $2`,
      [req.params.id, num]
    );
    if (!snapshot) return reply.code(404).send({ error: 'Snapshot not found' });

    // Capture current state as pre-restore safety net before overwriting.
    await captureSavedQuerySnapshot(req.params.id, 'pre-restore', req.body.edited_by || null);

    // Restore SQL on the live row + point current_snapshot at the snap whose
    // content the live SQL now matches (the historical one we restored from).
    const updated = await querySingle<any>(
      'UPDATE dbx.saved_queries SET sql = $1, current_snapshot = $2 WHERE id = $3 RETURNING *',
      [snapshot.sql, num, req.params.id]
    );

    // Restore params: replace existing rows with the snapshot's captured set.
    await query('DELETE FROM dbx.saved_query_params WHERE query_id = $1', [req.params.id]);
    const snapParams = Array.isArray(snapshot.params_snapshot) ? snapshot.params_snapshot : [];
    for (let i = 0; i < snapParams.length; i++) {
      const p = snapParams[i];
      await query(
        `INSERT INTO dbx.saved_query_params
           (query_id, name, value_type, required, default_value, options, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          req.params.id,
          p.name,
          p.value_type || 'text',
          p.required ?? false,
          p.default_value ?? null,
          p.options ? JSON.stringify(p.options) : null,
          p.sort_order ?? i,
        ]
      );
    }

    const paramRows = await query(
      'SELECT * FROM dbx.saved_query_params WHERE query_id = $1 ORDER BY sort_order, name',
      [req.params.id]
    );
    return { saved_query: { ...updated, params: paramRows } };
  });

  fastify.delete('/saved-queries/:id/snapshots/:num', async (req: FastifyRequest<{
    Params: { id: string; num: string }
  }>, reply) => {
    const num = parseInt(req.params.num, 10);
    if (!Number.isFinite(num)) return reply.code(400).send({ error: 'snapshot_number must be an integer' });

    // Mirror memories: the snapshot the live row is currently pointing at
    // cannot be deleted. Capture a new snapshot first to move the pointer.
    const sq = await querySingle<{ current_snapshot: number | null }>(
      'SELECT current_snapshot FROM dbx.saved_queries WHERE id = $1',
      [req.params.id]
    );
    if (sq && sq.current_snapshot === num) {
      return reply.code(409).send({
        error: 'Cannot delete the current snapshot. Capture a new one first to move the pointer, or restore a different snapshot.',
      });
    }

    const result = await query(
      'DELETE FROM dbx.saved_query_snapshots WHERE query_id = $1 AND snapshot_number = $2 RETURNING id',
      [req.params.id, num]
    );
    if (result.length === 0) return reply.code(404).send({ error: 'Snapshot not found' });
    return reply.code(204).send();
  });

  // ── Query history ──

  fastify.get('/connections/:id/history', async (req: FastifyRequest<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string }
  }>, reply) => {
    const conn = await requireConnection(req.params.id, reply);
    if (!conn) return;

    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);

    const rows = await query(
      `SELECT * FROM dbx.query_history
       WHERE connection_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );

    const countResult = await querySingle<{ count: string }>(
      'SELECT count(*) FROM dbx.query_history WHERE connection_id = $1',
      [req.params.id]
    );

    return {
      history: rows,
      pagination: {
        total_count: parseInt(countResult?.count || '0', 10),
        limit,
        offset,
        has_more: offset + limit < parseInt(countResult?.count || '0', 10),
      },
    };
  });

  fastify.delete('/connections/:id/history', async (req: FastifyRequest<{
    Params: { id: string }
  }>, reply) => {
    const conn = await requireConnection(req.params.id, reply);
    if (!conn) return;

    await query('DELETE FROM dbx.query_history WHERE connection_id = $1', [req.params.id]);
    return reply.code(204).send();
  });

  // ── Save ERD to khef ──

  fastify.post('/erd/save', async (req: FastifyRequest<{
    Body: {
      connection_name: string
      schema: string
      table?: string  // omit for schema-level ERD
      mermaid: string
    }
  }>, reply) => {
    const { connection_name, schema, table, mermaid } = req.body;
    if (!connection_name || !schema || !mermaid) {
      return reply.code(400).send({ error: 'connection_name, schema, and mermaid are required' });
    }

    const rawHandle = table ? `erd-${schema}-${table}` : `erd-${schema}`;
    const handle = rawHandle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const title = table ? `ERD: ${schema}.${table}` : `ERD: ${schema} schema`;
    const content = '```mermaid\n' + mermaid + '\n```';

    try {
      // 1. Ensure dbx project exists
      let projectRow = await querySingle<{ id: string }>('SELECT id FROM projects WHERE handle = $1', ['dbx']);
      if (!projectRow) {
        projectRow = await querySingle<{ id: string }>(
          "INSERT INTO projects (handle, name, display_name, description) VALUES ('dbx', 'DBX', 'DBX', 'Database Explorer diagrams and artifacts') RETURNING id",
          []
        );
      }
      const projectId = projectRow!.id;

      // 2. Ensure collection named after the connection exists
      const collectionHandle = connection_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      let collectionRow = await querySingle<{ id: string }>(
        'SELECT id FROM collections WHERE project_id = $1 AND handle = $2',
        [projectId, collectionHandle]
      );
      if (!collectionRow) {
        collectionRow = await querySingle<{ id: string }>(
          'INSERT INTO collections (project_id, handle, name, description) VALUES ($1, $2, $3, $4) RETURNING id',
          [projectId, collectionHandle, connection_name, `ERD diagrams for ${connection_name}`]
        );
      }
      const collectionId = collectionRow!.id;

      // 3. Resolve diagram type
      const diagramType = await querySingle<{ id: string; default_status_id: string }>(
        `SELECT mt.id, mts.id AS default_status_id
         FROM memory_types mt
         JOIN memory_type_statuses mts ON mts.memory_type_id = mt.id AND mts.sort_order = 0
         WHERE mt.name = 'diagram'`,
        []
      );
      if (!diagramType) return reply.code(500).send({ error: 'diagram memory type not found' });

      // 4. Create or update the memory
      const existing = await querySingle<{ id: string }>(
        'SELECT id FROM memories WHERE project_id = $1 AND handle = $2',
        [projectId, handle]
      );

      let memoryId: string;
      if (existing) {
        await saveSnapshot(existing.id);
        await query(
          'UPDATE memories SET content = $1, updated_at = NOW() WHERE id = $2',
          [content, existing.id]
        );
        memoryId = existing.id;
      } else {
        // Create new
        const newMem = await querySingle<{ id: string }>(
          `INSERT INTO memories (project_id, handle, title, content, memory_type_id, status_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [projectId, handle, title, content, diagramType.id, diagramType.default_status_id]
        );
        memoryId = newMem!.id;
      }

      // 5. Add to collection if not already a member
      const isMember = await querySingle<{ collection_id: string }>(
        'SELECT cm.collection_id FROM collection_memories cm WHERE cm.collection_id = $1 AND cm.memory_id = $2',
        [collectionId, memoryId]
      );
      if (!isMember) {
        const maxPos = await querySingle<{ max: number }>(
          'SELECT COALESCE(MAX(position), -1) AS max FROM collection_memories WHERE collection_id = $1',
          [collectionId]
        );
        await query(
          'INSERT INTO collection_memories (collection_id, memory_id, position) VALUES ($1, $2, $3)',
          [collectionId, memoryId, (maxPos?.max ?? -1) + 1]
        );
      }

      return {
        memory_id: memoryId,
        project_id: projectId,
        collection_id: collectionId,
        created: !existing,
        url: `/memories/${memoryId}`,
      };
    } catch (err: any) {
      log.error({ err }, 'Failed to save ERD');
      return reply.code(500).send({ error: err.message });
    }
  });
}
