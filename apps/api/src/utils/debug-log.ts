import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const LOG_PATH = join(process.cwd(), '..', '..', 'logs', 'api', 'debug.log');
const LOG_DIR = join(process.cwd(), '..', '..', 'logs', 'api');

export function logDebug(message: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    appendFileSync(LOG_PATH, `[${timestamp}] ${message}\n`, { encoding: 'utf8' });
  } catch {
    // Best-effort logging; ignore failures.
  }
}
