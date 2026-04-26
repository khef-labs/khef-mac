import { query } from '../db/client';
import { logger } from '../lib/logger';
import { getCachedActiveSessions } from './active-sessions';
import { clearNotification, getNotification, listNotifications, raiseNotification, type NotificationSeverity } from './notifications';

const log = logger.child({ component: 'session-context-watcher' });

const CHECK_INTERVAL_MS = 60_000;

interface Tier {
  threshold: number; // 0..1
  severity: NotificationSeverity;
  label: string;
}

const DEFAULT_TIERS: Tier[] = [
  { threshold: 0.50, severity: 'info', label: '50%' },
  { threshold: 0.75, severity: 'warning', label: '75%' },
  { threshold: 0.90, severity: 'error', label: '90%' },
];

const VALID_SEVERITIES: NotificationSeverity[] = ['info', 'warning', 'error'];

function parseTiers(raw: string | null): Tier[] {
  if (!raw) return DEFAULT_TIERS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_TIERS;
    const tiers: Tier[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const threshold = Number((entry as Record<string, unknown>).threshold);
      const severity = (entry as Record<string, unknown>).severity;
      if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) continue;
      if (typeof severity !== 'string' || !VALID_SEVERITIES.includes(severity as NotificationSeverity)) continue;
      tiers.push({
        threshold,
        severity: severity as NotificationSeverity,
        label: `${Math.round(threshold * 100)}%`,
      });
    }
    if (tiers.length === 0) return DEFAULT_TIERS;
    tiers.sort((a, b) => a.threshold - b.threshold);
    return tiers;
  } catch {
    return DEFAULT_TIERS;
  }
}

let interval: NodeJS.Timeout | null = null;

function getContextWindowSize(model: string | null): number | null {
  if (!model) return null;
  if (model.startsWith('claude-opus-4')) return 1_000_000;
  if (model.startsWith('claude-sonnet-4')) return 200_000;
  if (model.startsWith('claude-haiku-4')) return 200_000;
  if (model.startsWith('claude-3')) return 200_000;
  if (model.includes('gpt-4o') || model.includes('gpt-4')) return 128_000;
  if (model.includes('o3') || model.includes('o4')) return 200_000;
  return null;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m === Math.floor(m) ? `${m}M` : `${m.toFixed(2)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function highestTierCrossed(ratio: number, tiers: Tier[]): Tier | null {
  // Iterate from highest threshold down — first match wins.
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (ratio >= tiers[i].threshold) return tiers[i];
  }
  return null;
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

function notificationId(sessionId: string): string {
  return `session.context.${sessionId}`;
}

async function tick(): Promise<void> {
  const enabled = await getBooleanSetting('session.context.watch.enabled', true);
  if (!enabled) return;

  const tiers = parseTiers(await getSetting('session.context.warn.tiers'));

  let sessions: Awaited<ReturnType<typeof getCachedActiveSessions>>;
  try {
    sessions = await getCachedActiveSessions({ status: 'active' });
  } catch (err) {
    log.warn({ err }, 'failed to load active sessions');
    return;
  }

  const liveIds = new Set<string>();

  for (const s of sessions) {
    const tokens = s.context_window_tokens ? parseInt(s.context_window_tokens, 10) : null;
    const max = getContextWindowSize(s.model);
    if (!tokens || !max || tokens <= 0) continue;

    const ratio = tokens / max;
    const tier = highestTierCrossed(ratio, tiers);
    const id = notificationId(s.session_id);

    if (!tier) {
      // Below lowest tier — clear any stale notification (e.g. after compact)
      clearNotification(id);
      continue;
    }

    liveIds.add(id);

    // Escalation: if already dismissed at a lower tier, clear so a fresh raise
    // surfaces the new (higher) severity. Dismiss on the same or higher tier
    // stays silent.
    const existing = getNotification(id);
    if (existing?.dismissed) {
      const dismissedTier = Number(existing.dismissed_meta?.tier ?? 0);
      if (tier.threshold > dismissedTier) {
        clearNotification(id);
      }
    }

    const label = s.nickname ? `${s.nickname}` : s.session_id.slice(0, 8);
    const pct = Math.round(ratio * 100);

    raiseNotification({
      id,
      kind: 'session.context',
      severity: tier.severity,
      title: `${label}: context at ${pct}% (${formatTokens(tokens)} of ${formatTokens(max)})`,
      body: 'Consider compacting the session (/compact) or starting a follow-up to avoid a runaway context window.',
      dismissible: true,
      meta: {
        session_id: s.session_id,
        session_db_id: s.id,
        nickname: s.nickname,
        tokens,
        max_tokens: max,
        ratio,
        tier: tier.threshold,
        tier_label: tier.label,
        model: s.model,
      },
    });
  }

  // Clear notifications for sessions that are no longer active (ended, cleared, etc.)
  for (const n of listNotifications({ includeDismissed: true })) {
    if (n.kind !== 'session.context') continue;
    if (!liveIds.has(n.id)) {
      clearNotification(n.id);
    }
  }
}

export function startSessionContextWatcher(): void {
  if (interval) return;
  void tick();
  interval = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  log.info({ interval_ms: CHECK_INTERVAL_MS }, 'session context watcher started');
}

export function stopSessionContextWatcher(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info('session context watcher stopped');
  }
}
