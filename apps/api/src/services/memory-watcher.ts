import { query } from '../db/client';
import { logger } from '../lib/logger';
import { gatherProcessRows, findRootAppName, type ProcessRow } from '../routes/stats';
import { clearNotification, getNotification, raiseNotification } from './notifications';

const log = logger.child({ component: 'memory-watcher' });

const CHECK_INTERVAL_MS = 30_000;
const DEFAULT_ITERM_WARN_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB
// Re-surface a dismissed memory warning once RSS has grown this much past the
// value captured at dismiss time. 25% = gentle nudge as the leak keeps climbing.
const GROWTH_RESURFACE_FACTOR = 0.25;

let interval: NodeJS.Timeout | null = null;

function formatGB(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 10 ? `${gb.toFixed(1)} GB` : `${gb.toFixed(2)} GB`;
}

async function getSetting(key: string): Promise<string | null> {
  try {
    const rows = await query<{ value: string }>('SELECT value FROM settings WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

async function getBooleanSetting(key: string, fallback: boolean): Promise<boolean> {
  const raw = await getSetting(key);
  if (raw == null) return fallback;
  return raw === 'true' || raw === '1';
}

async function getNumberSetting(key: string, fallback: number): Promise<number> {
  const raw = await getSetting(key);
  if (raw == null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sumAppRss(rows: ProcessRow[], targetApp: string): { rss: number; pids: number } {
  const byPid = new Map<number, ProcessRow>();
  for (const row of rows) byPid.set(row.pid, row);

  let total = 0;
  let pids = 0;
  for (const row of rows) {
    const rss = row.mem + row.cmprs;
    if (rss === 0) continue;
    const root = findRootAppName(row.pid, byPid);
    if (root === targetApp) {
      total += rss;
      pids += 1;
    }
  }
  return { rss: total, pids };
}

async function tick(): Promise<void> {
  const enabled = await getBooleanSetting('memory.watch.enabled', true);
  if (!enabled) return;

  const threshold = await getNumberSetting('memory.iterm.warn_bytes', DEFAULT_ITERM_WARN_BYTES);

  let rows: ProcessRow[];
  try {
    rows = await gatherProcessRows();
  } catch (err) {
    log.warn({ err }, 'failed to gather process rows');
    return;
  }

  const { rss, pids } = sumAppRss(rows, 'iTerm');
  const id = 'memory.iterm';

  if (rss < threshold) {
    clearNotification(id);
    return;
  }

  // If the user already dismissed this notification, only re-surface it once
  // RSS has grown by GROWTH_RESURFACE_FACTOR beyond the value at dismiss time.
  const existing = getNotification(id);
  if (existing?.dismissed) {
    const anchor = Number(existing.dismissed_meta?.rss_bytes);
    if (Number.isFinite(anchor) && anchor > 0) {
      const resurfaceAt = anchor * (1 + GROWTH_RESURFACE_FACTOR);
      if (rss >= resurfaceAt) {
        // Clearing resets the dismissed flag; the raise below produces a fresh
        // visible notification reflecting the new RSS.
        clearNotification(id);
      }
    }
  }

  raiseNotification({
    id,
    kind: 'memory.warn',
    severity: 'warning',
    title: `iTerm is using ${formatGB(rss)}`,
    body: `Across ${pids} process${pids === 1 ? '' : 'es'}. Consider closing idle tabs — long Claude Code sessions can accumulate scrollback and leak memory.`,
    dismissible: true,
    meta: { app: 'iTerm', rss_bytes: rss, threshold_bytes: threshold, pid_count: pids },
  });
}

export function startMemoryWatcher(): void {
  if (interval) return;
  // Kick off one check immediately, then every CHECK_INTERVAL_MS
  void tick();
  interval = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  log.info({ interval_ms: CHECK_INTERVAL_MS }, 'memory watcher started');
}

export function stopMemoryWatcher(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info('memory watcher stopped');
  }
}
