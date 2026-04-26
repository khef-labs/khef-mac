import { useState, useEffect } from 'preact/hooks'
import { ExternalLink, X, Loader2 } from 'lucide-preact'
import { getMemory } from '../../lib/api'
import { getFullTypeLabel } from '../../lib/memoryTypes'
import type { CollectionMemoryItem } from '../../types'
import styles from './MemoryPreviewModal.module.css'

interface Props {
  memory: CollectionMemoryItem
  projectId: string
  onClose: () => void
  onOpen: (memoryId: string) => void
}

export function MemoryPreviewModal({ memory, projectId, onClose, onOpen }: Props) {
  const [content, setContent] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    getMemory(memory.id, projectId)
      .then((full) => {
        if (!cancelled) setContent(full.content || '')
      })
      .catch(() => {
        if (!cancelled) setContent(null)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => { cancelled = true }
  }, [memory.id, projectId])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <div class={styles.overlay} onClick={onClose}>
      <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div class={styles.header}>
          <div class={styles.headerMeta}>
            <span class={styles.typeBadge}>{getFullTypeLabel(memory.type, memory.parent_type)}</span>
            {memory.status && <span class={styles.statusBadge}>{memory.status}</span>}
            {memory.display_project && (
              <span class={styles.projectBadge}>{memory.display_project}</span>
            )}
          </div>
          <div class={styles.headerActions}>
            <button
              class={styles.openBtn}
              onClick={() => onOpen(memory.id)}
              title="Open full page"
            >
              <ExternalLink size={14} />
              Open
            </button>
            <button class={styles.closeBtn} onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        <div class={styles.body}>
          <h2 class={styles.title}>{memory.title}</h2>

          {memory.tags.length > 0 && (
            <div class={styles.tags}>
              {memory.tags.map((tag) => (
                <span key={tag.id} class={styles.tag}>{tag.name}</span>
              ))}
            </div>
          )}

          <div class={styles.content}>
            {isLoading ? (
              <div class={styles.loading}><Loader2 size={16} class="spin" /> Loading...</div>
            ) : content !== null ? (
              <pre class={styles.contentPre}>{content}</pre>
            ) : (
              <p class={styles.contentError}>Failed to load content</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
