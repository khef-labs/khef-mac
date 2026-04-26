import { useState, useEffect, useCallback } from 'preact/hooks'
import { Link } from 'wouter-preact'
import { Plus, Search, Trash2 } from 'lucide-preact'
import clsx from 'clsx'
import { getMemoryTypes, deleteMemoryType, type MemoryTypeListItem } from '../lib/api'
import { cardStyles } from '../components/ui'
import styles from './CustomTypesPage.module.css'

interface CustomTypesPageProps {
  embedded?: boolean
}

export function CustomTypesPage({ embedded }: CustomTypesPageProps = {}) {
  const [types, setTypes] = useState<MemoryTypeListItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<MemoryTypeListItem | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const loadTypes = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const allTypes = await getMemoryTypes()
      // Filter to only custom types (not built-in)
      setTypes(allTypes.filter((t) => !t.built_in))
    } catch (err) {
      console.warn('Failed to load memory types:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTypes()
  }, [loadTypes])

  const handleDeleteClick = (e: Event, type: MemoryTypeListItem) => {
    e.preventDefault()
    e.stopPropagation()
    setDeleteTarget(type)
  }

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      await deleteMemoryType(deleteTarget.type)
      setTypes((prev) => prev.filter((t) => t.type !== deleteTarget.type))
      setDeleteTarget(null)
    } catch (err: any) {
      setError(err.message || 'Failed to delete memory type')
    } finally {
      setIsDeleting(false)
    }
  }

  if (isLoading) {
    return (
      <div class={embedded ? undefined : styles.page}>
        <div class={styles.loading}>Loading...</div>
      </div>
    )
  }

  return (
    <div class={embedded ? undefined : styles.page}>
      <div class={styles.header}>

        <div class={styles.titleRow}>
          {!embedded ? <h1 class={styles.title}>Custom Memory Types</h1> : null}
          {types.length > 0 && (
            <div class={styles.filterRow}>
              <Search size={14} class={styles.filterIcon} />
              <input
                class={styles.filterInput}
                type="text"
                placeholder="Filter types"
                value={filter}
                onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
              />
            </div>
          )}
          <span class={styles.titleSpacer} />
          <Link href="/settings/custom-types/new" class={styles.addButton}>
            <Plus size={16} />
            Add Type
          </Link>
        </div>
        {!embedded && (
          <p class={styles.subtitle}>
            Create custom memory types with their own status workflows
          </p>
        )}
      </div>

      {error && <div class={styles.error}>{error}</div>}

      <div class={styles.typeList}>
        {types.length === 0 ? (
          <div class={styles.empty}>
            No custom memory types yet. Click "Add Type" to create one.
          </div>
        ) : (
          types
            .filter((t) => !filter || t.type.toLowerCase().includes(filter.toLowerCase()) || t.description?.toLowerCase().includes(filter.toLowerCase()))
            .map((type) => (
            <Link
              key={`${type.type}-${type.parent_type || ''}`}
              href={`/settings/custom-types/${encodeURIComponent(type.type)}/edit${type.parent_type ? `?parent=${encodeURIComponent(type.parent_type)}` : ''}`}
              class={clsx(cardStyles.card, cardStyles.interactive, styles.typeCard)}
            >
              <div class={styles.typeHeader}>
                <div class={styles.typeNameRow}>
                  <span class={styles.typeName}>{type.type}</span>
                  {type.parent_type && (
                    <span class={styles.parentBadge}>{type.parent_type}</span>
                  )}
                </div>
                <button
                  class={styles.deleteButton}
                  onClick={(e) => handleDeleteClick(e, type)}
                  disabled={type.memory_count > 0}
                  title={
                    type.memory_count > 0
                      ? `Cannot delete: ${type.memory_count} memories use this type`
                      : 'Delete type'
                  }
                  type="button"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {type.description && (
                <div class={styles.typeDescription}>{type.description}</div>
              )}
              <div class={styles.typeMeta}>
                <span>{type.statuses.length} statuses</span>
                <span>{type.memory_count} memories</span>
              </div>
            </Link>
          ))
        )}
      </div>

      {deleteTarget && (
        <div class={styles.modalOverlay} onClick={() => setDeleteTarget(null)}>
          <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 class={styles.modalTitle}>Delete Memory Type</h2>
            <p class={styles.modalText}>
              Are you sure you want to delete "{deleteTarget.type}"? This action cannot be undone.
            </p>
            <div class={styles.modalActions}>
              <button
                class={styles.modalButtonSecondary}
                onClick={() => setDeleteTarget(null)}
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                class={styles.modalButtonDanger}
                onClick={handleConfirmDelete}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
