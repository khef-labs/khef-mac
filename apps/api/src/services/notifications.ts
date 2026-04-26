import { logger } from '../lib/logger';
import { publishToRoom } from './session-events';

const log = logger.child({ component: 'notifications' });

const ROOM = 'notifications';

function notifyChange(reason: 'raised' | 'cleared' | 'dismissed', id: string): void {
  // Fire-and-forget; publishToRoom already swallows errors and logs.
  void publishToRoom(ROOM, { type: 'notifications.changed', reason, id });
}

export type NotificationSeverity = 'info' | 'warning' | 'error';

export interface Notification {
  id: string;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  dismissible: boolean;
  created_at: string;
  updated_at: string;
  dismissed: boolean;
  meta?: Record<string, unknown>;
  /** Snapshot of `meta` captured at the moment the notification was dismissed.
   *  Producers can use this as an anchor (e.g. RSS at dismiss time) to decide
   *  whether to escalate. */
  dismissed_meta?: Record<string, unknown>;
}

export interface RaiseInput {
  id: string;
  kind: string;
  severity?: NotificationSeverity;
  title: string;
  body?: string;
  dismissible?: boolean;
  meta?: Record<string, unknown>;
}

const store = new Map<string, Notification>();

export function raiseNotification(input: RaiseInput): Notification {
  const existing = store.get(input.id);
  const now = new Date().toISOString();
  const next: Notification = {
    id: input.id,
    kind: input.kind,
    severity: input.severity ?? 'info',
    title: input.title,
    body: input.body,
    dismissible: input.dismissible ?? true,
    meta: input.meta,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    // Preserve dismissed flag on re-raise — producers must call clearNotification
    // to reset dismissed (e.g. when the underlying condition clears, or when a
    // growth/time threshold warrants re-surfacing).
    dismissed: existing?.dismissed ?? false,
    dismissed_meta: existing?.dismissed_meta,
  };
  store.set(input.id, next);
  // Only emit when something visible to clients changed — re-raises with
  // identical content would otherwise spam the bus.
  if (
    !existing ||
    existing.title !== next.title ||
    existing.body !== next.body ||
    existing.severity !== next.severity ||
    existing.dismissed !== next.dismissed
  ) {
    notifyChange('raised', next.id);
  }
  return next;
}

export function clearNotification(id: string): boolean {
  const existed = store.delete(id);
  if (existed) {
    log.debug({ id }, 'notification cleared');
    notifyChange('cleared', id);
  }
  return existed;
}

export function dismissNotification(id: string): Notification | null {
  const existing = store.get(id);
  if (!existing) return null;
  if (!existing.dismissible) return existing;
  const updated: Notification = {
    ...existing,
    dismissed: true,
    updated_at: new Date().toISOString(),
    // Snapshot current meta so producers have an anchor for escalation logic.
    dismissed_meta: existing.meta ? { ...existing.meta } : undefined,
  };
  store.set(id, updated);
  notifyChange('dismissed', id);
  return updated;
}

export function listNotifications(options: { includeDismissed?: boolean } = {}): Notification[] {
  const all = [...store.values()];
  const filtered = options.includeDismissed ? all : all.filter((n) => !n.dismissed);
  return filtered.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function getNotification(id: string): Notification | undefined {
  return store.get(id);
}
