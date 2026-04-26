import { useState, useEffect } from 'preact/hooks'
import { X, Layers, Check, Loader2 } from 'lucide-preact'
import { getAllCollections, getMemoryCollections, addToCollection, removeFromCollection } from '../../lib/api'
import { useToast } from '../ui'
import styles from './AddToCollectionModal.module.css'

interface CollectionItem {
  id: string
  handle: string
  name: string
  description: string | null
  project_id: string
  project_handle: string
  project_name: string
  memory_count: number
}

interface AddToCollectionModalProps {
  memoryId: string
  projectId: string
  onClose: () => void
  onAdded?: (collectionId: string) => void
  onRemoved?: (collectionId: string) => void
}

export function AddToCollectionModal({
  memoryId,
  projectId,
  onClose,
  onAdded,
  onRemoved,
}: AddToCollectionModalProps) {
  const { showToast } = useToast()
  const [collections, setCollections] = useState<CollectionItem[]>([])
  const [memberOf, setMemberOf] = useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = useState(true)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true

    async function load() {
      try {
        const [allRes, memberRes] = await Promise.all([
          getAllCollections(),
          getMemoryCollections(projectId, memoryId),
        ])
        if (!mounted) return
        setCollections(allRes.collections)
        setMemberOf(new Set(memberRes.collections.map((c) => c.id)))
      } catch {
        if (mounted) showToast('Failed to load collections')
      } finally {
        if (mounted) setIsLoading(false)
      }
    }

    load()
    return () => { mounted = false }
  }, [projectId, memoryId])

  const handleToggle = async (col: CollectionItem) => {
    if (togglingId) return
    setTogglingId(col.id)
    const isMember = memberOf.has(col.id)
    try {
      if (isMember) {
        await removeFromCollection(col.project_id, col.id, memoryId)
        setMemberOf((prev) => {
          const next = new Set(prev)
          next.delete(col.id)
          return next
        })
        showToast('Removed from collection')
        onRemoved?.(col.id)
      } else {
        await addToCollection(col.project_id, col.id, memoryId)
        setMemberOf((prev) => new Set([...prev, col.id]))
        showToast('Added to collection')
        onAdded?.(col.id)
      }
    } catch (err: any) {
      if (!isMember && err?.response?.status === 409) {
        setMemberOf((prev) => new Set([...prev, col.id]))
      } else {
        showToast(err instanceof Error ? err.message : `Failed to ${isMember ? 'remove from' : 'add to'} collection`)
      }
    } finally {
      setTogglingId(null)
    }
  }

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Group collections by project, current project first
  const grouped = collections.reduce<Map<string, { projectName: string; projectHandle: string; items: CollectionItem[] }>>((acc, col) => {
    if (!acc.has(col.project_id)) {
      acc.set(col.project_id, { projectName: col.project_name, projectHandle: col.project_handle, items: [] })
    }
    acc.get(col.project_id)!.items.push(col)
    return acc
  }, new Map())

  // Sort: current project first, then alphabetically
  const sortedGroups = [...grouped.entries()].sort(([idA], [idB]) => {
    if (idA === projectId) return -1
    if (idB === projectId) return 1
    return 0
  })

  const multipleProjects = sortedGroups.length > 1

  return (
    <div class={styles.overlay} onClick={onClose}>
      <div class={styles.modal} onClick={(e) => e.stopPropagation()} data-testid="add-to-collection-modal">
        <div class={styles.header}>
          <h3 class={styles.title}>
            <Layers size={18} />
            Collections
          </h3>
          <button class={styles.closeBtn} onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div class={styles.body}>
          {isLoading ? (
            <div class={styles.loading}>Loading collections...</div>
          ) : collections.length === 0 ? (
            <div class={styles.empty}>
              <p>No collections in any project yet.</p>
              <a href={`/projects/${projectId}/collections`} class={styles.emptyLink}>
                Create a collection
              </a>
            </div>
          ) : (
            sortedGroups.map(([groupProjectId, group]) => (
              <div key={groupProjectId}>
                {multipleProjects && (
                  <div class={styles.projectGroup}>
                    {group.projectName}
                    {groupProjectId === projectId && <span class={styles.currentBadge}>current</span>}
                  </div>
                )}
                {group.items.map((col) => {
                  const isAdded = memberOf.has(col.id)
                  const isToggling = togglingId === col.id
                  return (
                    <div
                      key={col.id}
                      class={`${styles.collectionItem} ${isAdded ? styles.isMember : ''}`}
                      onClick={() => handleToggle(col)}
                      data-testid={`add-to-collection--item-${col.handle}`}
                    >
                      <div class={styles.collectionInfo}>
                        <span class={styles.collectionName}>{col.name}</span>
                        <div class={styles.collectionMeta}>
                          <span class={styles.collectionHandle}>{col.handle}</span>
                          <span>{col.memory_count} {col.memory_count === 1 ? 'memory' : 'memories'}</span>
                        </div>
                      </div>
                      {isToggling ? (
                        <Loader2 size={16} class={styles.addingSpinner} />
                      ) : isAdded ? (
                        <span class={styles.checkIcon}>
                          <Check size={16} />
                        </span>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
