import { useState, useRef, useEffect } from 'preact/hooks'
import { SlidersHorizontal, Eye, EyeOff, ChevronUp, ChevronDown } from 'lucide-preact'
import type { BoardColumn } from '../../types'
import styles from './ColumnFilter.module.css'

interface Props {
  columns: BoardColumn[]
  hiddenColumns: string[]
  columnOrder: string[]
  onToggle: (statusValue: string) => void
  onReorder: (order: string[]) => void
}

export function ColumnFilter({ columns, hiddenColumns, columnOrder, onToggle, onReorder }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Build ordered column list: use columnOrder if set, else columns as-is
  const orderedColumns = columnOrder.length > 0
    ? [
        ...columnOrder
          .map(sv => columns.find(c => c.status_value === sv))
          .filter(Boolean) as BoardColumn[],
        ...columns.filter(c => !columnOrder.includes(c.status_value)),
      ]
    : columns

  const handleMove = (statusValue: string, direction: 'up' | 'down') => {
    const currentOrder = orderedColumns.map(c => c.status_value)
    const idx = currentOrder.indexOf(statusValue)
    if (idx === -1) return
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= currentOrder.length) return
    const next = [...currentOrder]
    ;[next[idx], next[targetIdx]] = [next[targetIdx], next[idx]]
    onReorder(next)
  }

  const hiddenCount = hiddenColumns.length

  return (
    <div class={styles.wrapper} ref={ref}>
      <button
        class={`${styles.trigger} ${hiddenCount > 0 ? styles.hasHidden : ''}`}
        onClick={() => setOpen(!open)}
        title="Filter columns"
      >
        <SlidersHorizontal size={14} />
        {hiddenCount > 0 && <span class={styles.badge}>{hiddenCount}</span>}
      </button>

      {open && (
        <div class={styles.dropdown}>
          <div class={styles.dropdownHeader}>Columns</div>
          {orderedColumns.map((col, idx) => {
            const hidden = hiddenColumns.includes(col.status_value)
            return (
              <div key={col.status_value} class={`${styles.item} ${hidden ? styles.itemHidden : ''}`}>
                <button
                  class={styles.visibilityBtn}
                  onClick={() => onToggle(col.status_value)}
                  title={hidden ? 'Show column' : 'Hide column'}
                >
                  {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <span class={styles.itemLabel}>{col.display_name}</span>
                <span class={styles.itemCount}>{col.memories.length}</span>
                <div class={styles.moveButtons}>
                  <button
                    class={styles.moveBtn}
                    onClick={() => handleMove(col.status_value, 'up')}
                    disabled={idx === 0}
                    title="Move up"
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    class={styles.moveBtn}
                    onClick={() => handleMove(col.status_value, 'down')}
                    disabled={idx === orderedColumns.length - 1}
                    title="Move down"
                  >
                    <ChevronDown size={12} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
