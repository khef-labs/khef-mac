import { useEffect, useMemo, useState } from 'preact/hooks'
import { X, RotateCcw, Trash2 } from 'lucide-preact'
import {
  listSavedQuerySnapshots,
  restoreSavedQuerySnapshot,
  deleteSavedQuerySnapshot,
  type DbxSavedQuerySnapshot,
  type DbxSavedQuery,
} from '../../lib/dbx-api'
import styles from './SnapshotsModal.module.css'

interface Props {
  savedQueryId: string
  savedQueryName: string
  sessionId: string | null
  onClose: () => void
  /** Called after a restore so the parent can refresh the live tab content. */
  onRestored: (saved: DbxSavedQuery) => void
  /** Called after a delete so the parent can refresh its snapshot cache. */
  onChanged?: () => void | Promise<void>
}

function formatWhen(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

export function SnapshotsModal({
  savedQueryId,
  savedQueryName,
  sessionId,
  onClose,
  onRestored,
  onChanged,
}: Props) {
  const [snapshots, setSnapshots] = useState<DbxSavedQuerySnapshot[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [confirmBulk, setConfirmBulk] = useState(false)

  const [currentSnapshot, setCurrentSnapshot] = useState<number | null>(null)

  async function reload() {
    try {
      const { snapshots, current_snapshot } = await listSavedQuerySnapshots(savedQueryId)
      setSnapshots(snapshots)
      setCurrentSnapshot(current_snapshot)
    } catch (err: any) {
      setError(err?.message || 'Failed to load snapshots')
    }
  }

  useEffect(() => { reload() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [savedQueryId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const sorted = useMemo(
    () => (snapshots || []).slice().sort((a, b) => b.snapshot_number - a.snapshot_number),
    [snapshots]
  )

  const deletable = useMemo(
    () => sorted.filter(s => s.snapshot_number !== currentSnapshot),
    [sorted, currentSnapshot]
  )
  const allSelected = deletable.length > 0 && deletable.every((s) => selected.has(s.snapshot_number))

  function toggleOne(n: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(n)) next.delete(n); else next.add(n)
      return next
    })
  }

  async function handleRestore(num: number) {
    setBusy(`restore-${num}`); setError(null)
    try {
      const { saved_query } = await restoreSavedQuerySnapshot(savedQueryId, num, sessionId || undefined)
      await reload()
      onRestored(saved_query)
    } catch (err: any) {
      setError(err?.message || 'Failed to restore snapshot')
    } finally { setBusy(null) }
  }

  async function handleBulkDelete() {
    if (selected.size === 0) return
    setBusy('bulk-delete'); setError(null)
    try {
      // No bulk endpoint — fan out individual deletes. List is small (3-10).
      for (const num of selected) {
        await deleteSavedQuerySnapshot(savedQueryId, num)
      }
      setSelected(new Set())
      setConfirmBulk(false)
      await reload()
      await onChanged?.()
    } catch (err: any) {
      setError(err?.message || 'Failed to delete snapshots')
    } finally { setBusy(null) }
  }

  return (
    <div
      class={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}
      role="dialog"
      aria-modal="true"
    >
      <div class={styles.modal}>
        <div class={styles.header}>
          <div>
            <h2 class={styles.title}>Snapshots</h2>
            <p class={styles.subtitle}>{savedQueryName}</p>
          </div>
          <button class={styles.closeButton} onClick={onClose} disabled={!!busy} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {sorted.length > 0 && (
          <div class={styles.toolbar}>
            <button
              class={styles.toolbarLink}
              onClick={() => setSelected(allSelected ? new Set() : new Set(deletable.map(s => s.snapshot_number)))}
              disabled={!!busy || deletable.length === 0}
            >
              {allSelected ? 'Clear' : 'Select all'}
            </button>
            <div class={styles.toolbarSpacer} />
            <span class={styles.toolbarHint}>
              {currentSnapshot != null && (
                <>The current snapshot cannot be deleted. </>
              )}
              {selected.size > 0 ? `${selected.size} selected` : `${sorted.length} total`}
            </span>
          </div>
        )}

        {error && <div class={styles.error}>{error}</div>}

        {snapshots === null ? (
          <div class={styles.empty}>Loading…</div>
        ) : sorted.length === 0 ? (
          <div class={styles.empty}>No snapshots yet. Use the camera button in the toolbar to save the current SQL state.</div>
        ) : (
          <ul class={styles.list}>
            {sorted.map((s) => {
              const isCurrent = s.snapshot_number === currentSnapshot
              return (
                <li key={s.snapshot_number} class={styles.row}>
                  <input
                    type="checkbox"
                    class={styles.rowCheckbox}
                    checked={selected.has(s.snapshot_number)}
                    onChange={() => toggleOne(s.snapshot_number)}
                    disabled={!!busy || isCurrent}
                    title={isCurrent ? 'The current snapshot cannot be deleted' : undefined}
                  />
                  <span class={styles.rowNumber}>#{s.snapshot_number}{isCurrent && ' current'}</span>
                  <span class={styles.rowSource} data-source={s.source}>{s.source}</span>
                  <span class={styles.rowWhen}>{formatWhen(s.edited_at)}</span>
                  {s.edited_by && <span class={styles.rowAuthor}>by {s.edited_by}</span>}
                  <span class={styles.rowSpacer} />
                  <button
                    class={styles.rowAction}
                    onClick={() => handleRestore(s.snapshot_number)}
                    disabled={!!busy || isCurrent}
                    title={isCurrent
                      ? 'Already current'
                      : 'Restore — current SQL will be saved as a pre-restore safety snapshot first'}
                  >
                    <RotateCcw size={11} /> Restore
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {selected.size > 0 && (
          <div class={styles.footer}>
            <button class={styles.cancelButton} onClick={() => { setSelected(new Set()); setConfirmBulk(false) }} disabled={!!busy}>
              Cancel
            </button>
            {confirmBulk ? (
              <button class={styles.confirmDelete} onClick={handleBulkDelete} disabled={!!busy}>
                <Trash2 size={12} /> Confirm delete {selected.size}
              </button>
            ) : (
              <button class={styles.deleteButton} onClick={() => setConfirmBulk(true)} disabled={!!busy}>
                <Trash2 size={12} /> Delete {selected.size}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
