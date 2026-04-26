import { useEffect, useRef, useState } from 'preact/hooks'
import styles from './TypeToConfirmModal.module.css'

interface Props {
  title: string
  message: string
  confirmPhrase: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

export function TypeToConfirmModal({
  title,
  message,
  confirmPhrase,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [typed, setTyped] = useState('')

  const matches = typed === confirmPhrase

  useEffect(() => {
    inputRef.current?.focus()

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
      aria-labelledby="type-confirm-title"
    >
      <div class={styles.modal}>
        <h2 id="type-confirm-title" class={styles.title}>
          {title}
        </h2>
        <p class={styles.message}>{message}</p>
        <div class={styles.inputGroup}>
          <label class={styles.inputLabel}>
            Type <strong>{confirmPhrase}</strong> to confirm
          </label>
          <input
            ref={inputRef}
            class={styles.input}
            type="text"
            value={typed}
            onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches) {
                e.preventDefault()
                onConfirm()
              }
            }}
            placeholder={confirmPhrase}
            spellcheck={false}
            autocomplete="off"
            data-testid="type-confirm-modal--input"
          />
        </div>
        <div class={styles.actions}>
          <button class={styles.cancelButton} onClick={onCancel} type="button" data-testid="type-confirm-modal--cancel-button">
            {cancelLabel}
          </button>
          <button
            class={styles.dangerButton}
            onClick={onConfirm}
            type="button"
            disabled={!matches}
            data-testid="type-confirm-modal--confirm-button"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
