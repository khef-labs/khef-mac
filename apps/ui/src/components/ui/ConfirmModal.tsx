import { useEffect, useRef } from 'preact/hooks'
import styles from './ConfirmModal.module.css'

interface Props {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'danger' | 'default'
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  onCancel,
}: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirmRef.current?.focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  return (
    <div
      class={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
    >
      <div class={styles.modal}>
        <h2 id="confirm-title" class={styles.title}>
          {title}
        </h2>
        <p class={styles.message}>{message}</p>
        <div class={styles.actions}>
          <button class={styles.cancelButton} onClick={onCancel} type="button" data-testid="confirm-modal--cancel-button">
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            class={variant === 'danger' ? styles.dangerButton : styles.confirmButton}
            onClick={onConfirm}
            type="button"
            data-testid="confirm-modal--confirm-button"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
