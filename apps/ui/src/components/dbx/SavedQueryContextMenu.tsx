import { useEffect, useRef } from 'preact/hooks'
import { Edit3, Star, StarOff, Trash2 } from 'lucide-preact'
import type { DbxSavedQuery } from '../../lib/dbx-api'
import styles from './SavedQueryContextMenu.module.css'

interface Props {
  query: DbxSavedQuery
  position: { x: number; y: number }
  onOpenInEditor: () => void
  onToggleFavorite: () => void
  onDelete: () => void
  onClose: () => void
}

export function SavedQueryContextMenu({ query, position, onOpenInEditor, onToggleFavorite, onDelete, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)

  // Close on outside click, scroll, or Escape.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    function onScroll(e: Event) {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return
      onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  // Clamp the menu inside the viewport so it doesn't overflow on right-edge clicks.
  const x = Math.min(position.x, window.innerWidth - 200)
  const y = Math.min(position.y, window.innerHeight - 100)

  return (
    <div
      ref={menuRef}
      class={styles.menu}
      style={{ left: `${x}px`, top: `${y}px` }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button class={styles.item} onClick={() => { onOpenInEditor(); onClose() }}>
        <Edit3 size={13} class={styles.icon} /> Open in DB Editor
      </button>
      <button class={styles.item} onClick={() => { onToggleFavorite(); onClose() }}>
        {query.is_favorite
          ? <><StarOff size={13} class={styles.icon} /> Unmark as favorite</>
          : <><Star size={13} class={styles.icon} /> Mark as favorite</>}
      </button>
      {query.owner_session_id !== null && (
        <>
          <div class={styles.divider} />
          <button class={`${styles.item} ${styles.itemDanger}`} onClick={() => { onDelete(); onClose() }}>
            <Trash2 size={13} class={styles.iconDanger} /> Delete…
          </button>
        </>
      )}
    </div>
  )
}
