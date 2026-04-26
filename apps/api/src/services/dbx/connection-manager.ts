import { logger } from '../../lib/logger';
import { PostgresDriver } from './drivers/postgres';
import type { SqlDriver, DbxConnection } from './drivers/types';

const log = logger.child({ component: 'dbx-connection-manager' });

/** Cache of active driver instances keyed by connection ID */
const drivers = new Map<string, { driver: SqlDriver; lastUsed: number }>();

/** Idle timeout: disconnect drivers unused for 5 minutes */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function createDriver(conn: DbxConnection): SqlDriver {
  switch (conn.driver) {
    case 'postgres':
      return new PostgresDriver(conn.config, conn.credentials, conn.options);
    default:
      throw new Error(`Unsupported driver: ${conn.driver}`);
  }
}

export async function getDriver(conn: DbxConnection): Promise<SqlDriver> {
  const cached = drivers.get(conn.id);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.driver;
  }

  const driver = createDriver(conn);
  await driver.connect();
  drivers.set(conn.id, { driver, lastUsed: Date.now() });

  // Start cleanup timer on first connection
  if (!cleanupTimer) {
    cleanupTimer = setInterval(cleanupIdle, 60000);
  }

  return driver;
}

export async function removeDriver(connectionId: string): Promise<void> {
  const cached = drivers.get(connectionId);
  if (cached) {
    await cached.driver.disconnect().catch(err => {
      log.warn({ err, connectionId }, 'Error disconnecting driver');
    });
    drivers.delete(connectionId);
  }
}

async function cleanupIdle(): Promise<void> {
  const now = Date.now();
  for (const [id, entry] of drivers) {
    if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
      log.debug({ connectionId: id }, 'Disconnecting idle driver');
      await entry.driver.disconnect().catch(() => {});
      drivers.delete(id);
    }
  }
  if (drivers.size === 0 && cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

export async function disconnectAll(): Promise<void> {
  for (const [id, entry] of drivers) {
    await entry.driver.disconnect().catch(() => {});
  }
  drivers.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
