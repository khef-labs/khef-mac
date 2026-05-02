import { useEffect, useMemo, useState } from 'preact/hooks'
import { X, Trash2, MessageCircle } from 'lucide-preact'
import { bulkDeleteMemorySnapshots, type MemorySnapshotListItem } from '../../lib/api'
import styles from './SnapshotsManageModal.module.css'

interface Props {
  memoryId: string
  snapshots: MemorySnapshotListItem[]
  currentSnapshot: number
  onClose: () => void
  // Called after a successful bulk delete so the parent can refresh its data.
  onChanged: () => void | Promise<void>
}

function formatBytes(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function SnapshotsManageModal({
  memoryId,
  snapshots,
  currentSnapshot,
  onClose,
  onChanged,
}: Props) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [isDeleting, setIsDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Newest first; current is shown at the top but its checkbox is disabled.
  const sortedSnapshots = useMemo(
    () => [...snapshots].sort((a, b) => b.snapshot_number - a.snapshot_number),
    [snapshots]
  )

  const deletableSnapshots = useMemo(
    () => sortedSnapshots.filter((s) => s.snapshot_number !== currentSnapshot),
    [sortedSnapshots, currentSnapshot]
  )

  const olderThanCurrent = useMemo(
    () => deletableSnapshots.filter((s) => s.snapshot_number < currentSnapshot),
    [deletableSnapshots, currentSnapshot]
  )

  const autoUpdateSnapshots = useMemo(
    () => deletableSnapshots.filter((s) => s.source === 'pre-update'),
    [deletableSnapshots]
  )

  const allDeletableSelected =
    deletableSnapshots.length > 0 && deletableSnapshots.every((s) => selected.has(s.snapshot_number))

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isDeleting) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isDeleting, onClose])

  const toggleOne = (n: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      return next
    })
  }

  const selectAllDeletable = () => {
    setSelected(new Set(deletableSnapshots.map((s) => s.snapshot_number)))
  }

  const selectOlderThanCurrent = () => {
    setSelected(new Set(olderThanCurrent.map((s) => s.snapshot_number)))
  }

  const selectAutoUpdates = () => {
    setSelected(new Set(autoUpdateSnapshots.map((s) => s.snapshot_number)))
  }

  const clearSelection = () => setSelected(new Set())

  const handleDelete = async () => {
    if (selected.size === 0) return
    setIsDeleting(true)
    setError(null)
    try {
      await bulkDeleteMemorySnapshots(memoryId, Array.from(selected))
      setSelected(new Set())
      setConfirmDelete(false)
      await onChanged()
      onClose()
    } catch (err: any) {
      setError(err?.message || 'Failed to delete snapshots')
      setConfirmDelete(false)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <div
      class={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isDeleting) onClose()
      }}
      role="dialog"
      aria-modal="true"
    >
      <div class={styles.modal}>
        <div class={styles.header}>
          <h2 class={styles.title}>Manage Snapshots</h2>
          <button
            class={styles.closeButton}
            onClick={onClose}
            disabled={isDeleting}
            title="Close"
            aria-label="Close"
            type="button"
          >
            <X size={16} />
          </button>
        </div>

        <p class={styles.subtitle}>
          {snapshots.length} snapshot{snapshots.length === 1 ? '' : 's'} total. The current
          snapshot cannot be deleted.
        </p>

        <div class={styles.toolbar}>
          <button
            class={styles.toolbarButton}
            onClick={selectAllDeletable}
            disabled={isDeleting || deletableSnapshots.length === 0 || allDeletableSelected}
            type="button"
          >
            Select all
          </button>
          <button
            class={styles.toolbarButton}
            onClick={selectOlderThanCurrent}
            disabled={isDeleting || olderThanCurrent.length === 0}
            type="button"
          >
            Select older than current
          </button>
          <button
            class={styles.toolbarButton}
            onClick={selectAutoUpdates}
            disabled={isDeleting || autoUpdateSnapshots.length === 0}
            type="button"
            title="Select auto-snapshots saved before MCP content updates"
          >
            Select auto-updates ({autoUpdateSnapshots.length})
          </button>
          <button
            class={styles.toolbarButton}
            onClick={clearSelection}
            disabled={isDeleting || selected.size === 0}
            type="button"
          >
            Clear
          </button>
          <span class={styles.toolbarCount}>
            {selected.size} selected
          </span>
        </div>

        <ul class={styles.list}>
          {sortedSnapshots.map((s) => {
            const isCurrent = s.snapshot_number === currentSnapshot
            const isChecked = selected.has(s.snapshot_number)
            return (
              <li
                key={s.id}
                class={`${styles.row} ${isCurrent ? styles.rowCurrent : ''} ${isChecked ? styles.rowChecked : ''}`}
              >
                <label class={styles.rowLabel}>
                  <input
                    type="checkbox"
                    class={styles.checkbox}
                    checked={isChecked}
                    disabled={isCurrent || isDeleting}
                    onChange={() => toggleOne(s.snapshot_number)}
                  />
                  <span class={styles.rowNumber}>#{s.snapshot_number}</span>
                  {isCurrent && <span class={styles.currentBadge}>current</span>}
                  {s.source && <span class={styles.rowSource}>{s.source}</span>}
                  <span class={styles.rowDate}>{formatDate(s.created_at)}</span>
                  <span class={styles.rowSize}>{formatBytes(s.content_size)}</span>
                  {s.comment_count > 0 && (
                    <span class={styles.rowComments} title={`${s.comment_count} comment${s.comment_count === 1 ? '' : 's'}`}>
                      <MessageCircle size={12} />
                      {s.comment_count}
                    </span>
                  )}
                </label>
              </li>
            )
          })}
        </ul>

        {error && <div class={styles.error}>{error}</div>}

        <div class={styles.actions}>
          <button
            class={styles.cancelButton}
            onClick={onClose}
            disabled={isDeleting}
            type="button"
          >
            Cancel
          </button>
          {confirmDelete ? (
            <button
              class={styles.dangerButton}
              onClick={handleDelete}
              disabled={isDeleting || selected.size === 0}
              type="button"
            >
              <Trash2 size={14} />
              {isDeleting ? 'Deleting…' : `Confirm delete ${selected.size}`}
            </button>
          ) : (
            <button
              class={styles.dangerButton}
              onClick={() => setConfirmDelete(true)}
              disabled={isDeleting || selected.size === 0}
              type="button"
            >
              <Trash2 size={14} />
              Delete {selected.size > 0 ? `(${selected.size})` : ''}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
