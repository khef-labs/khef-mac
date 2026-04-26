import { useState, useEffect, useRef } from 'preact/hooks'
import { Check, ChevronRight, ArrowLeft, Copy, Pin, Layers } from 'lucide-preact'
import { getProjectMemoryTypeStatuses } from '../../lib/api'
import { MEMORY_TYPES, getTypeLabel } from '../../lib/memoryTypes'
import type { Memory, MemoryType, MemoryTypeStatusInfo } from '../../types'
import styles from './MemoryContextMenu.module.css'

// Fallback statuses per type (used when API returns nothing)
const STATUS_FALLBACK: Record<string, string[]> = {
  'user-todo': ['open', 'in_progress', 'done', 'blocked', 'canceled'],
  'assistant-todo': ['open', 'in_progress', 'done', 'blocked', 'canceled'],
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

interface MemoryContextMenuProps {
  memory: Memory
  position: { x: number; y: number }
  typeOptions?: string[]
  onChangeType: (type: MemoryType) => void
  onChangeStatus: (status: string) => void
  onTogglePin?: (isPinned: boolean) => void
  onAddToCollection?: () => void
  onDelete: () => void
  onClose: () => void
  onShowToast?: (message: string) => void
}

type MenuView = 'main' | 'type' | 'status'

export function MemoryContextMenu({
  memory,
  position,
  typeOptions,
  onChangeType,
  onChangeStatus,
  onTogglePin,
  onAddToCollection,
  onDelete,
  onClose,
  onShowToast,
}: MemoryContextMenuProps) {
  const [view, setView] = useState<MenuView>('main')
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

  // Load statuses when entering status sub-menu
  useEffect(() => {
    if (view !== 'status') return

    let mounted = true
    setIsLoadingStatuses(true)

    getProjectMemoryTypeStatuses(memory.project_id, memory.type)
      .then((data) => {
        if (!mounted) return
        if (data && data.statuses.length > 0) {
          setStatuses(data.statuses)
        } else {
          // Use fallback
          const fallback = STATUS_FALLBACK[memory.type] || []
          setStatuses(
            fallback.map((value, index) => ({
              value,
              display_name: null,
              description: null,
              sort_order: index,
            }))
          )
        }
      })
      .catch(() => {
        if (!mounted) return
        // Use fallback on error
        const fallback = STATUS_FALLBACK[memory.type] || []
        setStatuses(
          fallback.map((value, index) => ({
            value,
            display_name: null,
            description: null,
            sort_order: index,
          }))
        )
      })
      .finally(() => {
        if (mounted) setIsLoadingStatuses(false)
      })

    return () => {
      mounted = false
    }
  }, [view, memory.project_id, memory.type])

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    // Delay to avoid closing immediately on the same click that opened it
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

  // Close on scroll
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

  // Clamp position to viewport
  const getClampedPosition = () => {
    const menuWidth = 180
    const menuHeight = 200 // Estimate
    const padding = 8

    let x = position.x
    let y = position.y

    if (typeof window !== 'undefined') {
      const maxX = window.innerWidth - menuWidth - padding
      const maxY = window.innerHeight - menuHeight - padding

      if (x > maxX) x = maxX
      if (y > maxY) y = maxY
      if (x < padding) x = padding
      if (y < padding) y = padding
    }

    return { x, y }
  }

  const clampedPosition = getClampedPosition()

  const handleTypeSelect = (type: MemoryType) => {
    onChangeType(type)
  }

  const handleStatusSelect = (status: string) => {
    onChangeStatus(status)
  }

  return (
    <div
      ref={menuRef}
      class={styles.menu}
      style={{ left: `${clampedPosition.x}px`, top: `${clampedPosition.y}px` }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      data-testid="context-menu"
    >
      {view === 'main' && (
        <>
          <button
            type="button"
            class={styles.menuItem}
            onClick={() => setView('type')}
            data-testid="context-menu--change-type"
          >
            <span>Change Type</span>
            <ChevronRight size={14} class={styles.chevron} />
          </button>
          <button
            type="button"
            class={styles.menuItem}
            onClick={() => setView('status')}
            data-testid="context-menu--change-status"
          >
            <span>Change Status</span>
            <ChevronRight size={14} class={styles.chevron} />
          </button>
          {onTogglePin && (
            <button
              type="button"
              class={styles.menuItem}
              onClick={() => { onTogglePin(!memory.is_pinned); onClose() }}
            >
              <span>{memory.is_pinned ? 'Unpin' : 'Pin'}</span>
              <Pin size={14} />
            </button>
          )}
          {onAddToCollection && (
            <button
              type="button"
              class={styles.menuItem}
              onClick={() => { onAddToCollection(); onClose() }}
            >
              <span>Add to Collection</span>
              <Layers size={14} />
            </button>
          )}
          <div class={styles.divider} />
          <button
            type="button"
            class={styles.menuItem}
            onClick={copyMemoryId}
            data-testid="context-menu--copy-uuid"
          >
            <span>Copy UUID</span>
            <Copy size={14} class={styles.copyIcon} />
          </button>
          <div class={styles.divider} />
          <button
            type="button"
            class={`${styles.menuItem} ${styles.deleteItem}`}
            onClick={onDelete}
            data-testid="context-menu--delete"
          >
            Delete
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
          <div class={styles.scrollArea}>
            {(typeOptions && typeOptions.length > 0 ? typeOptions : MEMORY_TYPES).map((type) => {
              const isCurrent = type === memory.type
              return (
                <button
                  key={type}
                  type="button"
                  class={`${styles.menuItem} ${isCurrent ? styles.currentItem : ''}`}
                  onClick={() => handleTypeSelect(type as MemoryType)}
                >
                  <span>{getTypeLabel(type)}</span>
                  {isCurrent && <Check size={14} class={styles.checkIcon} />}
                </button>
              )
            })}
          </div>
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
            <div class={styles.noStatuses}>No statuses available</div>
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
                    onClick={() => handleStatusSelect(status.value)}
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
