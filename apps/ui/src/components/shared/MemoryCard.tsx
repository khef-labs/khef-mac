import { Pin } from 'lucide-preact'
import type { Memory } from '../../types'
import { TypeBadge, StatusBadge, TagBadge } from '../ui'
import styles from './MemoryCard.module.css'

interface MemoryCardProps {
  memory: Memory
  onClick: () => void
  onContextMenu?: (e: MouseEvent) => void
}

export function MemoryCard({ memory, onClick, onContextMenu }: MemoryCardProps) {
  const rawExcerpt = memory.content_excerpt || memory.content?.slice(0, 200) || ''
  const excerpt = (() => {
    if (!rawExcerpt) return undefined
    if (rawExcerpt.includes('<')) {
      const doc = new DOMParser().parseFromString(rawExcerpt, 'text/html')
      const text = doc.body.textContent || ''
      return text.replace(/\s+/g, ' ').trim() || undefined
    }
    return rawExcerpt.replace(/\s+/g, ' ').trim() || undefined
  })()

  const handleContextMenu = (e: MouseEvent) => {
    if (onContextMenu) {
      e.preventDefault()
      onContextMenu(e)
    }
  }

  return (
    <button class={styles.card} onClick={onClick} onContextMenu={handleContextMenu} type="button" data-testid={`memory-card--${memory.id}`}>
      <div class={styles.header}>
        <TypeBadge type={memory.type} parentType={memory.parent_type} />
        <StatusBadge status={memory.status} />
        {memory.is_seeded && <span class={styles.seedBadge} title="Seeded from disk" data-testid={`memory-card--seed-badge--${memory.id}`}>Seed</span>}
        {memory.is_pinned && <Pin size={12} class={styles.pinIcon} />}
      </div>

      <h3 class={styles.title}>{memory.title}</h3>

      {excerpt && <p class={styles.excerpt}>{excerpt}</p>}

      <div class={styles.footer}>
        {memory.tags?.slice(0, 3).map((tag) => (
          <TagBadge key={tag.id} name={tag.name} />
        ))}
        {memory.tags && memory.tags.length > 3 && (
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>
            +{memory.tags.length - 3}
          </span>
        )}
        {memory.project_handle && (
          <span class={styles.projectBadge}>{memory.project_handle}</span>
        )}
        {memory.semantic_score !== undefined && (
          <span class={styles.semanticScore} title={`Similarity: ${memory.semantic_score.toFixed(4)}`}>
            <span
              class={styles.scoreBar}
              style={{ width: `${Math.round(memory.semantic_score * 100)}%` }}
            />
            <span class={styles.scoreText}>{Math.round(memory.semantic_score * 100)}%</span>
          </span>
        )}
        {memory.score !== undefined && memory.semantic_score === undefined && (
          <span class={styles.score}>{memory.score.toFixed(2)}</span>
        )}
      </div>
    </button>
  )
}
