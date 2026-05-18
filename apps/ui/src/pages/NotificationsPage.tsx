import { useEffect, useMemo, useState } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import { AlertCircle, AlertTriangle, Bell, ExternalLink, Info, X } from 'lucide-preact'
import clsx from 'clsx'
import {
  NOTIFICATION_SEVERITY_RANK,
  useNotifications,
} from '../components/shared/NotificationsContext'
import type { Notification, NotificationSeverity } from '../lib/api'
import styles from './NotificationsPage.module.css'

const KIND_LABELS: Record<string, string> = {
  'memory.iterm': 'High memory',
  'memory.warn': 'High memory',
  'session.context': 'Session context',
  debug: 'Debug',
}

function iconFor(severity: NotificationSeverity) {
  switch (severity) {
    case 'error':
      return AlertCircle
    case 'warning':
      return AlertTriangle
    default:
      return Info
  }
}

function highestSeverity(list: Notification[]): NotificationSeverity | null {
  let max: NotificationSeverity | null = null
  for (const n of list) {
    if (max === null || NOTIFICATION_SEVERITY_RANK[n.severity] > NOTIFICATION_SEVERITY_RANK[max]) {
      max = n.severity
    }
  }
  return max
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diffSec = Math.floor((Date.now() - then) / 1000)
  if (diffSec < 5) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`
  return `${Math.floor(diffSec / 86_400)}d ago`
}

function hrefFor(n: Notification): string | null {
  if (n.kind === 'session.context') {
    const dbId = n.meta?.session_db_id as string | undefined
    if (dbId) return `/sessions/${dbId}`
  }
  return null
}

export function NotificationsPage() {
  const { notifications, total, dismiss, dismissGroup, dismissAll } = useNotifications()
  const [, setLocation] = useLocation()

  // Tick relative timestamps every 30s.
  const [, setNow] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setNow((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  const grouped = useMemo(() => {
    const map = new Map<string, Notification[]>()
    for (const n of notifications) {
      const key = n.kind || 'other'
      const list = map.get(key) ?? []
      list.push(n)
      map.set(key, list)
    }
    return Array.from(map.entries()).sort((a, b) => {
      const sa = NOTIFICATION_SEVERITY_RANK[highestSeverity(a[1]) ?? 'info']
      const sb = NOTIFICATION_SEVERITY_RANK[highestSeverity(b[1]) ?? 'info']
      return sb - sa
    })
  }, [notifications])

  return (
    <div class={styles.page} data-testid="notifications-page">
      <header class={styles.header}>
        <div class={styles.headerLeft}>
          <Bell size={20} class={styles.headerIcon} />
          <h1 class={styles.title}>Alerts</h1>
          {total > 0 && <span class={styles.titleTotal}>{total}</span>}
        </div>
        <button
          type="button"
          class={styles.headAction}
          onClick={dismissAll}
          disabled={total === 0}
          data-testid="notifications-page--dismiss-all"
        >
          Dismiss all
        </button>
      </header>

      <div class={styles.body}>
        {total === 0 ? (
          <div class={styles.empty}>
            <Bell size={32} class={styles.emptyIcon} />
            <div class={styles.emptyTitle}>You&rsquo;re all caught up.</div>
            <div class={styles.emptyText}>
              Warnings and errors from your sessions and services will show up here.
            </div>
          </div>
        ) : (
          grouped.map(([kind, items]) => (
            <section key={kind} class={styles.group} data-testid={`notifications-group--${kind}`}>
              <div class={styles.groupHead}>
                <span class={styles.groupHeadLeft}>
                  {KIND_LABELS[kind] ?? kind}
                  <span class={styles.groupCount}>{items.length}</span>
                </span>
                <button
                  type="button"
                  class={styles.groupDismiss}
                  onClick={() => dismissGroup(kind)}
                >
                  Dismiss group
                </button>
              </div>
              {items.map((n) => {
                const Icon = iconFor(n.severity)
                const href = hrefFor(n)
                return (
                  <article
                    key={n.id}
                    class={clsx(
                      styles.notif,
                      n.severity === 'info' && styles.severityInfo,
                      n.severity === 'warning' && styles.severityWarning,
                      n.severity === 'error' && styles.severityError
                    )}
                    data-testid={`notification--${n.id}`}
                  >
                    <span class={styles.notifIcon}>
                      <Icon size={18} />
                    </span>
                    <div class={styles.notifBody}>
                      <div class={styles.notifTitle}>{n.title}</div>
                      {n.body && <div class={styles.notifText}>{n.body}</div>}
                      <div class={styles.notifTime}>{formatRelativeTime(n.created_at)}</div>
                    </div>
                    <div class={styles.notifActions}>
                      {href && (
                        <button
                          type="button"
                          class={styles.iconBtn}
                          onClick={() => setLocation(href)}
                          title="Open"
                          aria-label="Open"
                        >
                          <ExternalLink size={14} />
                        </button>
                      )}
                      {n.dismissible && (
                        <button
                          type="button"
                          class={styles.iconBtn}
                          onClick={() => dismiss(n.id)}
                          title="Dismiss"
                          aria-label="Dismiss notification"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  </article>
                )
              })}
            </section>
          ))
        )}
      </div>
    </div>
  )
}
