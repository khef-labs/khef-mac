import { useState, useEffect, useRef } from 'preact/hooks'
import styles from './DbxPage.module.css'

interface SaveScriptDialogProps {
  onSave: (name: string) => void
  onCancel: () => void
  title?: string
}

export function SaveScriptDialog({ onSave, onCancel, title = 'Save Script' }: SaveScriptDialogProps) {
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function handleSubmit(e: Event) {
    e.preventDefault()
    if (name.trim()) onSave(name.trim())
  }

  return (
    <div class={styles.dialogOverlay} onClick={onCancel}>
      <div class={styles.dialog} onClick={e => e.stopPropagation()} style={{ width: '380px' }}>
        <div class={styles.dialogTitle}>{title}</div>
        <form onSubmit={handleSubmit}>
          <div class={styles.formGroup}>
            <label class={styles.formLabel}>Script Name</label>
            <input
              ref={inputRef}
              class={styles.formInput}
              value={name}
              onInput={e => setName((e.target as HTMLInputElement).value)}
              placeholder="my-query"
              onKeyDown={e => { if (e.key === 'Escape') onCancel() }}
            />
          </div>
          <div class={styles.dialogActions}>
            <button type="button" class={styles.btnSecondary} onClick={onCancel}>Cancel</button>
            <button type="submit" class={styles.btnPrimary} disabled={!name.trim()}>Save</button>
          </div>
        </form>
      </div>
    </div>
  )
}
