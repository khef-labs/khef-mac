import { useEffect, useRef, useState } from 'preact/hooks'
import type { DbxConnection, DbxSavedQuery } from '../../lib/dbx-api'
import styles from './CloneSavedQueryModal.module.css'

interface Props {
  source: DbxSavedQuery
  connections: DbxConnection[]
  busy?: boolean
  errorMessage?: string | null
  onConfirm: (input: { name: string; connectionId: string | null }) => void
  onCancel: () => void
}

export function CloneSavedQueryModal({ source, connections, busy, errorMessage, onConfirm, onCancel }: Props) {
  const [name, setName] = useState(`${source.name} (copy)`)
  // Default to source's bound connection; when the source is null-bound
  // (System), default to the builtin connection so the user lands on a
  // real picker option matching what the SQL editor's tab select shows.
  const builtinId = connections.find(c => c.is_builtin)?.id ?? null
  const [connectionId, setConnectionId] = useState<string | null>(source.connection_id ?? builtinId)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const trimmed = name.trim()
  const canSubmit = !!trimmed && !busy

  function submit() {
    if (!canSubmit) return
    onConfirm({ name: trimmed, connectionId })
  }

  return (
    <div class={styles.overlay} onClick={onCancel}>
      <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 class={styles.title}>Clone Query</h2>

        <div class={styles.source}>
          <span class={styles.sourceLabel}>Source</span>
          <span class={styles.sourceName}>{source.name}</span>
        </div>

        <div class={styles.field}>
          <label class={styles.label} for="clone-name">New title</label>
          <input
            id="clone-name"
            ref={inputRef}
            class={styles.input}
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          />
        </div>

        <div class={styles.field}>
          <label class={styles.label} for="clone-connection">Connection</label>
          <select
            id="clone-connection"
            class={styles.select}
            value={connectionId ?? ''}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value
              setConnectionId(v || null)
            }}
          >
            {connections.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}{c.config?.host ? ` (${c.config.host}:${c.config.port})` : ''}
              </option>
            ))}
          </select>
        </div>

        {errorMessage && <div class={styles.error}>{errorMessage}</div>}

        <div class={styles.actions}>
          <button class={styles.cancelButton} onClick={onCancel}>Cancel</button>
          <button class={styles.confirmButton} onClick={submit} disabled={!canSubmit}>
            {busy ? 'Cloning…' : 'Clone'}
          </button>
        </div>
      </div>
    </div>
  )
}
