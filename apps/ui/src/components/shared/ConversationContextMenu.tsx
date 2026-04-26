import { useEffect, useRef } from 'preact/hooks'
import { Copy, Pencil } from 'lucide-preact'
import styles from './MemoryContextMenu.module.css'

interface ConversationContextMenuProps {
  conversationId: string
  position: { x: number; y: number }
  onDelete: () => void
  onRename?: () => void
  onClose: () => void
  onShowToast?: (message: string) => void
}

export function ConversationContextMenu({
  conversationId,
  position,
  onDelete,
  onRename,
  onClose,
  onShowToast,
}: ConversationContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(conversationId)
      onShowToast?.('UUID copied')
      onClose()
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

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
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

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
    const menuWidth = 160
    const menuHeight = 80
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

  return (
    <div
      ref={menuRef}
      class={styles.menu}
      style={{ left: `${clampedPosition.x}px`, top: `${clampedPosition.y}px` }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {onRename && (
        <button
          type="button"
          class={styles.menuItem}
          onClick={() => { onRename(); onClose(); }}
        >
          <span>Rename</span>
          <Pencil size={14} class={styles.copyIcon} />
        </button>
      )}
      <button
        type="button"
        class={styles.menuItem}
        onClick={copyId}
      >
        <span>Copy UUID</span>
        <Copy size={14} class={styles.copyIcon} />
      </button>
      <div class={styles.divider} />
      <button
        type="button"
        class={`${styles.menuItem} ${styles.deleteItem}`}
        onClick={onDelete}
      >
        Delete
      </button>
    </div>
  )
}
