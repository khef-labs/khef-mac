import { X } from 'lucide-preact'
import clsx from 'clsx'
import { useNotifications } from './NotificationsContext'
import styles from './NotificationsToasts.module.css'

export function NotificationsToasts() {
  const { toasts, dismissToast } = useNotifications()
  if (toasts.length === 0) return null

  return (
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
            onClick={() => dismissToast(notif.id)}
            aria-label="Dismiss toast"
            title="Dismiss"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
