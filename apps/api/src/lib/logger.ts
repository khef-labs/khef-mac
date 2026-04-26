/**
 * Structured logging with daily rolling log files.
 *
 * Two loggers:
 *   - logger: API server (requests, routes, startup)
 *   - workerLogger: Background workers (vector-sync, session-sync, etc.)
 *
 * Both write to stdout + rolling files in LOG_DIR.
 */

import pino from 'pino';
import { join } from 'path';

const LOG_DIR = process.env.LOG_DIR || join(process.cwd(), '..', '..', 'logs', 'api');
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const MAX_FILES = 10;
const IS_TEST = process.env.NODE_ENV === 'test';
const DISABLE_FILES = process.env.LOG_DISABLE_FILES === 'true';

function createTransportTargets(filename: string): pino.TransportMultiOptions['targets'] {
  if (IS_TEST || DISABLE_FILES) {
    // Stdout only — no file transports (test mode or bundled desktop runtime)
    return [
      {
        target: 'pino/file',
        options: { destination: 1 },
        level: LOG_LEVEL,
      },
    ];
  }

  return [
    // stdout (pretty in dev, JSON otherwise)
    {
      target: process.env.NODE_ENV === 'production' ? 'pino/file' : 'pino-pretty',
      options: process.env.NODE_ENV === 'production' ? { destination: 1 } : {},
      level: LOG_LEVEL,
    },
    // Rolling file
    {
      target: 'pino-roll',
      options: {
        file: join(LOG_DIR, filename),
        frequency: 'daily',
        limit: { count: MAX_FILES },
        mkdir: true,
      },
      level: LOG_LEVEL,
    },
  ];
}

/** Main API logger — used by Fastify and general services. */
export const logger = pino({
  level: LOG_LEVEL,
  transport: {
    targets: createTransportTargets('khef.log'),
  },
});

/** Worker logger — used by background sync workers. */
export const workerLogger = pino({
  level: LOG_LEVEL,
  transport: {
    targets: createTransportTargets('khef-workers.log'),
  },
});
