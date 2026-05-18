import { createContext } from 'preact'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import {
  getNotifications,
  dismissNotification,
  type Notification,
  type NotificationSeverity,
} from '../../lib/api'
import { subscribe as sseSubscribe } from '../../lib/sseClient'

const BACKSTOP_POLL_MS = 120_000

export const NOTIFICATION_SEVERITY_RANK: Record<NotificationSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
}

const TOAST_LIFETIME_MS: Record<NotificationSeverity, number> = {
  info: 0,
  warning: 4500,
  error: 8000,
}

export interface ToastEntry {
  notif: Notification
  expiresAt: number
}

interface NotificationsValue {
  notifications: Notification[]
  toasts: ToastEntry[]
  total: number
  topSeverity: NotificationSeverity | null
  dismiss: (id: string) => Promise<void>
  dismissGroup: (kind: string) => Promise<void>
  dismissAll: () => Promise<void>
  dismissToast: (id: string) => void
}

const NotificationsCtx = createContext<NotificationsValue | null>(null)

function highestSeverity(list: Notification[]): NotificationSeverity | null {
  let max: NotificationSeverity | null = null
  for (const n of list) {
    if (max === null || NOTIFICATION_SEVERITY_RANK[n.severity] > NOTIFICATION_SEVERITY_RANK[max]) {
      max = n.severity
    }
  }
  return max
}

export function NotificationsProvider({ children }: { children: ComponentChildren }) {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const seenRef = useRef<Set<string>>(new Set())
  const seededRef = useRef(false)

  const load = useCallback(async () => {
    try {
      const res = await getNotifications()
      const incoming = res.notifications

      if (seededRef.current) {
        const nextToasts: ToastEntry[] = []
        const now = Date.now()
        for (const n of incoming) {
          if (seenRef.current.has(n.id)) continue
          if (NOTIFICATION_SEVERITY_RANK[n.severity] >= NOTIFICATION_SEVERITY_RANK.warning) {
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

  const dismiss = useCallback(async (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id))
    seenRef.current.delete(id)
    try {
      await dismissNotification(id)
    } catch {
      /* reconciled on next poll */
    }
  }, [])

  const dismissGroup = useCallback(
    async (kind: string) => {
      const ids = notifications.filter((n) => n.kind === kind).map((n) => n.id)
      setNotifications((prev) => prev.filter((n) => n.kind !== kind))
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

  const dismissAll = useCallback(async () => {
    const ids = notifications.map((n) => n.id)
    setNotifications([])
    for (const id of ids) seenRef.current.delete(id)
    await Promise.all(
      ids.map((id) =>
        dismissNotification(id).catch(() => {
          /* reconciled on next poll */
        })
      )
    )
  }, [notifications])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.notif.id !== id))
  }, [])

  const value = useMemo<NotificationsValue>(
    () => ({
      notifications,
      toasts,
      total: notifications.length,
      topSeverity: highestSeverity(notifications),
      dismiss,
      dismissGroup,
      dismissAll,
      dismissToast,
    }),
    [notifications, toasts, dismiss, dismissGroup, dismissAll, dismissToast]
  )

  return <NotificationsCtx.Provider value={value}>{children}</NotificationsCtx.Provider>
}

export function useNotifications(): NotificationsValue {
  const ctx = useContext(NotificationsCtx)
  if (!ctx) {
    // Allow consumers outside the provider (e.g., in tests) to no-op gracefully.
    return {
      notifications: [],
      toasts: [],
      total: 0,
      topSeverity: null,
      dismiss: async () => {},
      dismissGroup: async () => {},
      dismissAll: async () => {},
      dismissToast: () => {},
    }
  }
  return ctx
}
