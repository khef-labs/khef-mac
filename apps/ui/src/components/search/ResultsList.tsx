import { useLocation, useSearch } from 'wouter-preact'
import { SearchX } from 'lucide-preact'
import clsx from 'clsx'
import type { Memory, Pagination } from '../../types'
import { MemoryCard } from '../shared'
import { setNavContext } from '../../lib/navContext'
import styles from './ResultsList.module.css'

interface ResultsListProps {
  memories: Memory[]
  pagination: Pagination | null
  isLoading: boolean
  hasQuery: boolean
  onContextMenu?: (e: MouseEvent, memory: Memory) => void
}

export function ResultsList({ memories, pagination, isLoading, hasQuery, onContextMenu }: ResultsListProps) {
  const [, setLocation] = useLocation()
  const searchString = useSearch()

  const handleMemoryClick = (memoryId: string) => {
    const ids = memories.map((m) => m.id)
    const source = searchString ? `/search?${searchString}` : '/search'
    setNavContext(ids, memoryId, source)
    setLocation(`/memories/${memoryId}`)
  }

  if (isLoading) {
    return (
      <div class={styles.list}>
        {Array.from({ length: 5 }).map((_, i) => (
          <ResultSkeleton key={i} />
        ))}
      </div>
    )
  }

  if (memories.length === 0) {
    return (
      <div class={styles.empty}>
        <SearchX class={styles.emptyIcon} size={48} />
        <h2 class={styles.emptyTitle}>
          {hasQuery ? 'No memories found' : 'Start searching'}
        </h2>
        <p class={styles.emptyText}>
          {hasQuery
            ? 'Try adjusting your search query or filters to find what you\'re looking for.'
            : 'Enter a search term or apply filters to find memories.'}
        </p>
      </div>
    )
  }

  return (
    <div>
      {pagination && (
        <div class={styles.meta}>
          <span>
            Showing {memories.length} of {pagination.total_count} result
            {pagination.total_count !== 1 ? 's' : ''}
          </span>
        </div>
      )}
      <div class={styles.list}>
        {memories.map((memory) => (
          <MemoryCard
            key={memory.id}
            memory={memory}
            onClick={() => handleMemoryClick(memory.id)}
            onContextMenu={onContextMenu ? (e) => onContextMenu(e, memory) : undefined}
          />
        ))}
      </div>
    </div>
  )
}

function ResultSkeleton() {
  return (
    <div class={styles.skeleton}>
      <div class={styles.skeletonHeader}>
        <div class={clsx(styles.skeletonBar, styles.skeletonBadge)} />
        <div class={clsx(styles.skeletonBar, styles.skeletonBadge)} />
      </div>
      <div class={clsx(styles.skeletonBar, styles.skeletonTitle)} />
      <div class={clsx(styles.skeletonBar, styles.skeletonExcerpt)} />
      <div class={styles.skeletonTags}>
        <div class={clsx(styles.skeletonBar, styles.skeletonTag)} />
        <div class={clsx(styles.skeletonBar, styles.skeletonTag)} />
      </div>
    </div>
  )
}
