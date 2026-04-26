import { useState, useEffect, useRef } from 'preact/hooks'
import { Check, ChevronRight, ArrowLeft, Copy, Trash2, XCircle } from 'lucide-preact'
import { getProjectMemoryTypeStatuses, getProjectMemoryTypes } from '../../lib/api'
import { getFullTypeLabel } from '../../lib/memoryTypes'
import type { CollectionMemoryItem, MemoryType, MemoryTypeInfo, MemoryTypeStatusInfo } from '../../types'
import styles from './CollectionCardMenu.module.css'

const STATUS_FALLBACK: Record<string, string[]> = {
  'user-todo': ['open', 'in_progress', 'done', 'blocked', 'canceled'],
  'assistant-todo': ['open', 'in_progress', 'done', 'blocked', 'canceled'],
  ticket: ['open', 'in_progress', 'done', 'blocked', 'canceled'],
  task: ['open', 'in_progress', 'done', 'blocked', 'canceled'],
  story: ['open', 'in_progress', 'done', 'blocked', 'canceled'],
  epic: ['open', 'in_progress', 'done', 'blocked', 'canceled'],
  spike: ['open', 'in_progress', 'done', 'blocked', 'canceled'],
  defect: ['open', 'in_progress', 'done', 'blocked', 'canceled'],
  decision: ['proposed', 'accepted', 'rejected', 'superseded'],
  pattern: ['proposed', 'active', 'deprecated'],
  context: ['current', 'updated', 'outdated'],
  commands: ['unverified', 'verified', 'deprecated'],
  knowledge: ['current', 'deprecated'],
}

function labelize(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

interface Props {
  memory: CollectionMemoryItem
  projectId: string
  position: { x: number; y: number }
  onChangeType: (memoryId: string, type: MemoryType) => void
  onChangeStatus: (memoryId: string, status: string) => void
  onRemove: (memory: CollectionMemoryItem) => void
  onDelete: (memory: CollectionMemoryItem) => void
  onClose: () => void
  onShowToast?: (message: string) => void
}

type MenuView = 'main' | 'type' | 'status'

export function CollectionCardMenu({
  memory,
  projectId,
  position,
  onChangeType,
  onChangeStatus,
  onRemove,
  onDelete,
  onClose,
  onShowToast,
}: Props) {
  const [view, setView] = useState<MenuView>('main')
  const [typeOptions, setTypeOptions] = useState<MemoryTypeInfo[]>([])
  const [isLoadingTypes, setIsLoadingTypes] = useState(false)
  const [statuses, setStatuses] = useState<MemoryTypeStatusInfo[]>([])
  const [isLoadingStatuses, setIsLoadingStatuses] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const copyMemoryId = async () => {
    try {
      await navigator.clipboard.writeText(memory.id)
      onShowToast?.('UUID copied')
      onClose()
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  // Load types when entering type sub-menu
  useEffect(() => {
    if (view !== 'type') return
    if (typeOptions.length > 0) return // already loaded
    let mounted = true
    setIsLoadingTypes(true)
    getProjectMemoryTypes(projectId)
      .then((data) => {
        if (!mounted) return
        const types = (data?.memory_types || []).sort((a, b) => {
          const aLabel = getFullTypeLabel(a.type, a.parent_type)
          const bLabel = getFullTypeLabel(b.type, b.parent_type)
          return aLabel.localeCompare(bLabel)
        })
        setTypeOptions(types)
      })
      .catch(() => {
        if (!mounted) return
        setTypeOptions([])
      })
      .finally(() => {
        if (mounted) setIsLoadingTypes(false)
      })
    return () => { mounted = false }
  }, [view, projectId])

  // Load statuses when entering status sub-menu
  useEffect(() => {
    if (view !== 'status') return
    let mounted = true
    setIsLoadingStatuses(true)

    const memType = memory.type
    getProjectMemoryTypeStatuses(projectId, memType as any)
      .then((data) => {
        if (!mounted) return
        if (data && data.statuses.length > 0) {
          setStatuses(data.statuses)
        } else {
          const fallback = STATUS_FALLBACK[memType] || STATUS_FALLBACK[memory.parent_type || ''] || []
          setStatuses(fallback.map((value, index) => ({
            value,
            display_name: null,
            description: null,
            sort_order: index,
          })))
        }
      })
      .catch(() => {
        if (!mounted) return
        const fallback = STATUS_FALLBACK[memType] || STATUS_FALLBACK[memory.parent_type || ''] || []
        setStatuses(fallback.map((value, index) => ({
          value,
          display_name: null,
          description: null,
          sort_order: index,
        })))
      })
      .finally(() => {
        if (mounted) setIsLoadingStatuses(false)
      })

    return () => { mounted = false }
  }, [view, projectId, memory.type, memory.parent_type])

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClick)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', handleClick)
    }
  }, [onClose])

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (view !== 'main') {
          setView('main')
        } else {
          onClose()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [view, onClose])

  // Close on scroll (excluding internal scroll)
  useEffect(() => {
    const handleScroll = (event: Event) => {
      if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) {
        return
      }
      onClose()
    }
    window.addEventListener('scroll', handleScroll, true)
    return () => window.removeEventListener('scroll', handleScroll, true)
  }, [onClose])

  const getClampedPosition = () => {
    const menuWidth = 200
    const menuHeight = 220
    const padding = 8
    let x = position.x
    let y = position.y
    if (typeof window !== 'undefined') {
      if (x > window.innerWidth - menuWidth - padding) x = window.innerWidth - menuWidth - padding
      if (y > window.innerHeight - menuHeight - padding) y = window.innerHeight - menuHeight - padding
      if (x < padding) x = padding
      if (y < padding) y = padding
    }
    return { x, y }
  }

  const clamped = getClampedPosition()

  return (
    <div
      ref={menuRef}
      class={styles.menu}
      style={{ left: `${clamped.x}px`, top: `${clamped.y}px` }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {view === 'main' && (
        <>
          <button type="button" class={styles.menuItem} onClick={() => setView('type')}>
            <span>Change Type</span>
            <ChevronRight size={14} class={styles.chevron} />
          </button>
          <button type="button" class={styles.menuItem} onClick={() => setView('status')}>
            <span>Change Status</span>
            <ChevronRight size={14} class={styles.chevron} />
          </button>
          <div class={styles.divider} />
          <button type="button" class={styles.menuItem} onClick={copyMemoryId}>
            <span>Copy UUID</span>
            <Copy size={14} class={styles.dimIcon} />
          </button>
          <div class={styles.divider} />
          <button
            type="button"
            class={styles.menuItem}
            onClick={() => { onRemove(memory); onClose() }}
          >
            <span>Remove from Collection</span>
            <XCircle size={14} class={styles.dimIcon} />
          </button>
          <button
            type="button"
            class={`${styles.menuItem} ${styles.deleteItem}`}
            onClick={() => { onDelete(memory); onClose() }}
          >
            <span>Delete Memory</span>
            <Trash2 size={14} />
          </button>
        </>
      )}

      {view === 'type' && (
        <>
          <button
            type="button"
            class={`${styles.menuItem} ${styles.backItem}`}
            onClick={() => setView('main')}
          >
            <ArrowLeft size={14} />
            <span>Back</span>
          </button>
          <div class={styles.divider} />
          {isLoadingTypes ? (
            <div class={styles.loading}>Loading...</div>
          ) : typeOptions.length === 0 ? (
            <div class={styles.loading}>No types available</div>
          ) : (
            <div class={styles.scrollArea}>
              {typeOptions.map((t) => {
                const isCurrent = t.type === memory.type
                return (
                  <button
                    key={t.type}
                    type="button"
                    class={`${styles.menuItem} ${isCurrent ? styles.currentItem : ''}`}
                    onClick={() => { onChangeType(memory.id, t.type as MemoryType); onClose() }}
                  >
                    <span>{getFullTypeLabel(t.type, t.parent_type)}</span>
                    {isCurrent && <Check size={14} class={styles.checkIcon} />}
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}

      {view === 'status' && (
        <>
          <button
            type="button"
            class={`${styles.menuItem} ${styles.backItem}`}
            onClick={() => setView('main')}
          >
            <ArrowLeft size={14} />
            <span>Back</span>
          </button>
          <div class={styles.divider} />
          {isLoadingStatuses ? (
            <div class={styles.loading}>Loading...</div>
          ) : statuses.length === 0 ? (
            <div class={styles.loading}>No statuses available</div>
          ) : (
            <div class={styles.scrollArea}>
              {statuses.map((status) => {
                const isCurrent = status.value === memory.status
                const label = status.display_name || labelize(status.value)
                return (
                  <button
                    key={status.value}
                    type="button"
                    class={`${styles.menuItem} ${isCurrent ? styles.currentItem : ''}`}
                    onClick={() => { onChangeStatus(memory.id, status.value); onClose() }}
                  >
                    <span>{label}</span>
                    {isCurrent && <Check size={14} class={styles.checkIcon} />}
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
