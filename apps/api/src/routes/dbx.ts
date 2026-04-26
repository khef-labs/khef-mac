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

async function requireConnection(id: string, reply: FastifyReply): Promise<DbxConnection | null> {
  const conn = await getConnection(id);
  if (!conn) {
    reply.code(404).send({ error: 'Connection not found' });
    return null;
  }
  return conn;
}

const HISTORY_CAP = 500;

async function recordHistory(
  connectionId: string,
  sql: string,
  rowCount: number | null,
  durationMs: number | null,
  error: string | null
): Promise<void> {
  try {
    await query(
      `INSERT INTO dbx.query_history (connection_id, sql, row_count, duration_ms, error)
       VALUES ($1, $2, $3, $4, $5)`,
      [connectionId, sql, rowCount, durationMs, error]
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
