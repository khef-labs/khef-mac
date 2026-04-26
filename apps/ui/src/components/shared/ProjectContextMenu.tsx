import { useEffect, useRef } from 'preact/hooks'
import { Star } from 'lucide-preact'
import type { Project } from '../../types'
import styles from './ProjectContextMenu.module.css'

interface ProjectContextMenuProps {
  project: Project
  position: { x: number; y: number }
  onToggleFavorite: () => void
  onClose: () => void
}

export function ProjectContextMenu({
  project,
  position,
  onToggleFavorite,
  onClose,
}: ProjectContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

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
    const menuWidth = 180
    const menuHeight = 50
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
      <button
        type="button"
        class={styles.menuItem}
        onClick={() => {
          onToggleFavorite()
          onClose()
        }}
      >
        <Star size={14} fill={project.is_favorite ? 'currentColor' : 'none'} />
        <span>{project.is_favorite ? 'Remove from favorites' : 'Add to favorites'}</span>
      </button>
    </div>
  )
}
