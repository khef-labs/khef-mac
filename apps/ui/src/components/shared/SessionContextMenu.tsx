import { useEffect, useRef } from 'preact/hooks'
import { Copy, Sparkles, ExternalLink, Terminal, EyeOff } from 'lucide-preact'
import styles from './MemoryContextMenu.module.css'

interface SessionContextMenuProps {
  sessionId: string
  nickname?: string
  position: { x: number; y: number }
  onClose: () => void
  onShowToast?: (message: string) => void
  onDescribe?: (sessionId: string) => void
  onOpen?: (sessionId: string) => void
  onCopyResume?: (sessionId: string) => void
  onRemove?: (sessionId: string) => void
}

export function SessionContextMenu({
  sessionId,
  position,
  onClose,
  onShowToast,
  onDescribe,
  onOpen,
  onCopyResume,
  onRemove,
}: SessionContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(sessionId)
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
    const menuWidth = 220
    const itemCount = 1 +
      (onDescribe ? 1 : 0) +
      (onOpen ? 1 : 0) +
      (onCopyResume ? 1 : 0) +
      (onRemove ? 1 : 0)
    const menuHeight = itemCount * 36 + 16
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
      {onOpen && (
        <button
          type="button"
          class={styles.menuItem}
          onClick={() => {
            onOpen(sessionId)
            onClose()
          }}
        >
          <span>Open session page</span>
          <ExternalLink size={14} class={styles.copyIcon} />
        </button>
      )}
      {onDescribe && (
        <button
          type="button"
          class={styles.menuItem}
          onClick={() => {
            onDescribe(sessionId)
            onClose()
          }}
        >
          <span>Describe</span>
          <Sparkles size={14} class={styles.copyIcon} />
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
      {onCopyResume && (
        <button
          type="button"
          class={styles.menuItem}
          onClick={() => {
            onCopyResume(sessionId)
            onClose()
          }}
        >
          <span>Copy resume command</span>
          <Terminal size={14} class={styles.copyIcon} />
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          class={styles.menuItem}
          onClick={() => {
            onRemove(sessionId)
            onClose()
          }}
        >
          <span>Remove from sidebar</span>
          <EyeOff size={14} class={styles.copyIcon} />
        </button>
      )}
    </div>
  )
}
