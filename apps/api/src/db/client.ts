import { Pool, PoolClient } from 'pg';
import { logger } from '../lib/logger';

const log = logger.child({ component: 'db' });

// Lazy pool initialization. The pool is created on first use, not at import time.
// This ensures process.env.DATABASE_URL has been set correctly by test setup
// before the pool connects (ES import hoisting runs imports before top-level code).
let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      keepAlive: true,
    });

    pool.on('error', (err) => {
      log.error({ err }, 'Unexpected error on idle client');
    });
  }
  return pool;
}

// Safeguard: block destructive DDL (TRUNCATE, DROP) on non-test databases.
const DESTRUCTIVE_RE = /^\s*(TRUNCATE|DROP)\b/i;
const isTestDb = () => {
  const url = process.env.DATABASE_URL || '';
  return url.includes('_test') || url.includes(':5433') || url.includes(':5435');
};

export const query = async <T = any>(text: string, params?: any[]): Promise<T[]> => {
  if (DESTRUCTIVE_RE.test(text) && !isTestDb()) {
    throw new Error(
      `BLOCKED: destructive query on non-test database. ` +
      `DATABASE_URL: ${process.env.DATABASE_URL?.replace(/\/\/.*@/, '//*****@') || 'unknown'}. ` +
      `Set DATABASE_URL to a test database before importing db/client.`
    );
  }
  const result = await getPool().query(text, params);
  return result.rows;
};

export const querySingle = async <T = any>(text: string, params?: any[]): Promise<T | null> => {
  const result = await getPool().query(text, params);
  return result.rows.length > 0 ? result.rows[0] : null;
};

export const getClient = (): Promise<PoolClient> => {
  return getPool().connect();
};

export const closePool = async (): Promise<void> => {
  if (pool) {
    await pool.end();
    pool = null;
  }
};

export default new Proxy({} as Pool, {
  get(_target, prop) {
    return (getPool() as any)[prop];
  }
});
