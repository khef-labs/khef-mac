import { useState, useEffect } from 'preact/hooks'
import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import styles from './Toast.module.css'

interface ToastAction {
  label: string
  href?: string
  onClick?: () => void
}

type ToastVariant = 'success' | 'error'

interface ToastData {
  message: string
  action?: ToastAction
  persistent?: boolean
  variant?: ToastVariant
}

interface ToastContextType {
  showToast: (message: string, action?: ToastAction, options?: { persistent?: boolean; variant?: ToastVariant }) => void
}

const ToastContext = createContext<ToastContextType | null>(null)

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return context
}

interface ToastProviderProps {
  children: ComponentChildren
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toast, setToast] = useState<ToastData | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (toast) {
      setVisible(true)
      if (toast.persistent) return
      const duration = toast.action ? 4000 : 1500
      const timer = setTimeout(() => {
        setVisible(false)
        setTimeout(() => setToast(null), 200)
      }, duration)
      return () => clearTimeout(timer)
    }
  }, [toast])

  const dismiss = () => {
    setVisible(false)
    setTimeout(() => setToast(null), 200)
  }

  const showToast = (message: string, action?: ToastAction, options?: { persistent?: boolean; variant?: ToastVariant }) => {
    setToast({ message, action, persistent: options?.persistent, variant: options?.variant })
  }

  const handleActionClick = (e: MouseEvent) => {
    if (toast?.action?.onClick) {
      e.preventDefault()
      toast.action.onClick()
    }
    setVisible(false)
    setTimeout(() => setToast(null), 200)
  }

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast && (
        <div class={`${styles.toast} ${visible ? styles.visible : ''} ${toast.action || toast.persistent ? styles.hasAction : ''} ${toast.variant === 'error' ? styles.error : ''}`} data-testid="toast">
          <span>{toast.message}</span>
          {toast.action && (
            toast.action.href ? (
              <a href={toast.action.href} class={styles.action} onClick={handleActionClick}>
                {toast.action.label}
              </a>
            ) : (
              <button type="button" class={styles.action} onClick={handleActionClick}>
                {toast.action.label}
              </button>
            )
          )}
          {toast.persistent && (
            <button type="button" class={styles.dismiss} onClick={dismiss} aria-label="Dismiss">
              ✕
            </button>
          )}
        </div>
      )}
    </ToastContext.Provider>
  )
}
