import { useState, useEffect, useCallback, useMemo, useRef } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import { Bell, X, AlertTriangle, AlertCircle, Info, ExternalLink } from 'lucide-preact'
import clsx from 'clsx'
import {
  getNotifications,
  dismissNotification,
  type Notification,
  type NotificationSeverity,
} from '../../lib/api'
import { subscribe as sseSubscribe } from '../../lib/sseClient'
import styles from './NotificationsBanner.module.css'

// Backstop poll in case an SSE event is dropped (server restart, network blip).
// SSE pushes drive the normal refresh path, so this can be loose.
const BACKSTOP_POLL_MS = 120_000

const KIND_LABELS: Record<string, string> = {
  'memory.iterm': 'High memory',
  'memory.warn': 'High memory',
  'session.context': 'Session context',
  debug: 'Debug',
}

const SEVERITY_RANK: Record<NotificationSeverity, number> = { info: 0, warning: 1, error: 2 }

const TOAST_LIFETIME_MS: Record<NotificationSeverity, number> = {
  info: 0, // never toasted
  warning: 4500,
  error: 8000,
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
    if (max === null || SEVERITY_RANK[n.severity] > SEVERITY_RANK[max]) max = n.severity
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

interface ToastEntry {
  notif: Notification
  expiresAt: number
}

export function NotificationsBanner() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [open, setOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const seenRef = useRef<Set<string>>(new Set())
  const seededRef = useRef(false)
  const [, setLocation] = useLocation()

  const load = useCallback(async () => {
    try {
      const res = await getNotifications()
      const incoming = res.notifications

      // Toast new arrivals at severity >= warning. Skip on the first load so we
      // don't blast the user with a toast for everything that's already in the
      // list when the page mounts.
      if (seededRef.current) {
        const nextToasts: ToastEntry[] = []
        const now = Date.now()
        for (const n of incoming) {
          if (seenRef.current.has(n.id)) continue
          if (SEVERITY_RANK[n.severity] >= SEVERITY_RANK.warning) {
            nextToasts.push({ notif: n, expiresAt: now + TOAST_LIFETIME_MS[n.severity] })
          }
        }
        if (nextToasts.length > 0) {
          setToasts((prev) => [...prev, ...nextToasts])
        }
      }
      seenRef.current = new Set(incoming.map((n) => n.id))
      seededRef.current = true
      setNotifications(incoming)
    } catch {
      // Silently fail — never block the UI on notification fetch errors
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), BACKSTOP_POLL_MS)
    const unsubscribe = sseSubscribe(['notifications'], () => {
      void load()
    })
    return () => {
      clearInterval(timer)
      unsubscribe()
    }
  }, [load])

  // Auto-expire toasts.
  useEffect(() => {
    if (toasts.length === 0) return
    const earliest = toasts.reduce(
      (min, t) => (t.expiresAt < min ? t.expiresAt : min),
      Number.POSITIVE_INFINITY
    )
    const wait = Math.max(0, earliest - Date.now())
    const timer = setTimeout(() => {
      const now = Date.now()
      setToasts((prev) => prev.filter((t) => t.expiresAt > now))
    }, wait + 50)
    return () => clearTimeout(timer)
  }, [toasts])

  // Dismiss the dropdown when clicking outside.
  useEffect(() => {
    if (!open) return
    const onDown = (ev: MouseEvent) => {
      if (!wrapRef.current) return
      if (ev.target instanceof Node && wrapRef.current.contains(ev.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Re-render every 30s so relative timestamps tick.
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
      const sa = SEVERITY_RANK[highestSeverity(a[1]) ?? 'info']
      const sb = SEVERITY_RANK[highestSeverity(b[1]) ?? 'info']
      return sb - sa
    })
  }, [notifications])

  const total = notifications.length
  const topSeverity = highestSeverity(notifications)

  const handleDismiss = useCallback(async (id: string) => {
    // Optimistic update for snappy UX.
    setNotifications((prev) => {
      const next = prev.filter((n) => n.id !== id)
      if (next.length === 0) setOpen(false)
      return next
    })
    seenRef.current.delete(id)
    try {
      await dismissNotification(id)
    } catch {
      // The next poll/SSE event will reconcile if the call failed.
    }
  }, [])

  const handleDismissGroup = useCallback(
    async (kind: string) => {
      const ids = notifications.filter((n) => n.kind === kind).map((n) => n.id)
      setNotifications((prev) => {
        const next = prev.filter((n) => n.kind !== kind)
        if (next.length === 0) setOpen(false)
        return next
      })
      for (const id of ids) seenRef.current.delete(id)
      await Promise.all(
        ids.map((id) =>
          dismissNotification(id).catch(() => {
            /* reconciled on next poll */
          })
        )
      )
    },
    [notifications]
  )

  const handleDismissAll = useCallback(async () => {
    const ids = notifications.map((n) => n.id)
    setNotifications([])
    setOpen(false)
    for (const id of ids) seenRef.current.delete(id)
    await Promise.all(
      ids.map((id) =>
        dismissNotification(id).catch(() => {
          /* reconciled on next poll */
        })
      )
    )
  }, [notifications])

  const handleNotifClick = useCallback(
    (n: Notification) => {
      const href = hrefFor(n)
      if (!href) return
      setOpen(false)
      setLocation(href)
    },
    [setLocation]
  )

  const handleToastDismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.notif.id !== id))
  }, [])

  return (
    <>
      <div ref={wrapRef} class={styles.wrap}>
        <button
          type="button"
          class={clsx(styles.bellBtn, open && styles.bellBtnOpen)}
          onClick={() => setOpen((v) => !v)}
          aria-label="Notifications"
          aria-expanded={open}
          data-testid="notifications-bell"
        >
          <Bell size={18} />
          {total > 0 && (
            <span
              class={clsx(
                styles.badge,
                topSeverity === 'warning' && styles.badgeWarning,
                topSeverity === 'info' && styles.badgeInfo
              )}
            >
              {total > 99 ? '99+' : total}
            </span>
          )}
        </button>

        <div
          class={clsx(styles.panel, open && styles.panelOpen)}
          role="dialog"
          aria-label="Notifications panel"
        >
          <div class={styles.panelHead}>
            <div class={styles.panelTitle}>
              Notifications
              {total > 0 && <span class={styles.panelTitleTotal}>· {total}</span>}
            </div>
            <button
              type="button"
              class={styles.headAction}
              onClick={handleDismissAll}
              disabled={total === 0}
            >
              Dismiss all
            </button>
          </div>
          <div class={styles.panelBody}>
            {total === 0 ? (
              <div class={styles.empty}>You're all caught up.</div>
            ) : (
              grouped.map(([kind, items]) => (
                <div key={kind} class={styles.group}>
                  <div class={styles.groupHead}>
                    <span class={styles.groupHeadLeft}>
                      {KIND_LABELS[kind] ?? kind}
                      <span class={styles.groupCount}>{items.length}</span>
                    </span>
                    <button
                      type="button"
                      class={styles.groupDismiss}
                      onClick={() => handleDismissGroup(kind)}
                    >
                      Dismiss group
                    </button>
                  </div>
                  {items.map((n) => {
                    const Icon = iconFor(n.severity)
                    const href = hrefFor(n)
                    return (
                      <div
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
                          <Icon size={16} />
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
                              onClick={() => handleNotifClick(n)}
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
                              onClick={() => handleDismiss(n.id)}
                              title="Dismiss"
                              aria-label="Dismiss notification"
                            >
                              <X size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {toasts.length > 0 && (
        <div class={styles.toastStack} aria-live="polite">
          {toasts.map(({ notif }) => (
            <div
              key={notif.id}
              class={clsx(styles.toast, notif.severity === 'error' && styles.toastSeverityError)}
              data-testid={`notification-toast--${notif.id}`}
            >
              <div class={styles.toastBody}>
                <div class={styles.toastTitle}>{notif.title}</div>
                {notif.body && <div class={styles.toastText}>{notif.body}</div>}
              </div>
              <button
                type="button"
                class={styles.toastDismiss}
                onClick={() => handleToastDismiss(notif.id)}
                aria-label="Dismiss toast"
                title="Dismiss"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
