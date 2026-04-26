import { useLocation, useSearch } from 'wouter-preact'
import { SearchX, FileText } from 'lucide-preact'
import type { SessionKeywordSearchResult } from '../../types'
import styles from './SessionResultsList.module.css'

interface KeywordSessionResultsListProps {
  results: SessionKeywordSearchResult[]
  isLoading: boolean
  hasQuery: boolean
}

// Parse excerpt with << >> markers into highlighted segments
function parseExcerpt(excerpt: string): { text: string; highlight: boolean }[] {
  const segments: { text: string; highlight: boolean }[] = []
  let remaining = excerpt

  while (remaining.length > 0) {
    const startIdx = remaining.indexOf('<<')
    if (startIdx === -1) {
      segments.push({ text: remaining, highlight: false })
      break
    }

    if (startIdx > 0) {
      segments.push({ text: remaining.slice(0, startIdx), highlight: false })
    }

    const endIdx = remaining.indexOf('>>', startIdx)
    if (endIdx === -1) {
      segments.push({ text: remaining.slice(startIdx), highlight: false })
      break
    }

    segments.push({ text: remaining.slice(startIdx + 2, endIdx), highlight: true })
    remaining = remaining.slice(endIdx + 2)
  }

  return segments.filter(s => s.text)
}

export function KeywordSessionResultsList({ results, isLoading, hasQuery }: KeywordSessionResultsListProps) {
  const [, setLocation] = useLocation()
  const searchString = useSearch()

  const handleResultClick = async (result: SessionKeywordSearchResult) => {
    const from = encodeURIComponent(searchString ? `/search?${searchString}` : '/search')

    // Navigate to project-scoped session page when project is known
    if (result.project_id) {
      setLocation(`/projects/${result.project_id}/sessions/${result.id}?from=${from}`)
    } else {
      setLocation(`/sessions/${result.id}?from=${from}`)
    }
  }

  if (isLoading) {
    return (
      <div class={styles.list}>
        {Array.from({ length: 3 }).map((_, i) => (
          <KeywordSessionResultSkeleton key={i} />
        ))}
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <div class={styles.empty}>
        <SearchX class={styles.emptyIcon} size={48} />
        <h2 class={styles.emptyTitle}>
          {hasQuery ? 'No sessions found' : 'Search sessions'}
        </h2>
        <p class={styles.emptyText}>
          {hasQuery
            ? 'Try adjusting your search query to find relevant sessions.'
            : 'Enter a search term to find conversations in your session history.'}
        </p>
      </div>
    )
  }

  return (
    <div>
      <div class={styles.meta}>
        <span>
          Found {results.length} result{results.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div class={styles.list}>
        {results.map((result, i) => (
          <div
            key={`${result.session_id}-${result.chunk_index}-${i}`}
            class={styles.card}
            onClick={() => handleResultClick(result)}
          >
            <div class={styles.cardHeader}>
              {result.project_handle && (
                <span class={styles.projectBadge}>
                  {result.project_handle}
                </span>
              )}
              {(result.nickname || result.session_id) && (
                <span class={styles.sessionLabel}>
                  {result.nickname || result.session_id.slice(0, 8)}
                </span>
              )}
              <span class={styles.score}>
                rank {result.rank.toFixed(2)}
              </span>
              <span class={styles.chunk}>
                chunk {result.chunk_index + 1}
              </span>
            </div>
            {(result.summary || result.name) && (
              <div class={styles.summary}>{result.summary || result.name}</div>
            )}
            <div class={styles.content}>
              <div class={styles.segment}>
                <span class={styles.segmentIcon}>
                  <FileText size={14} />
                </span>
                <span class={styles.segmentText}>
                  {parseExcerpt(result.excerpt).map((seg, j) => (
                    seg.highlight
                      ? <mark key={j}>{seg.text}</mark>
                      : <span key={j}>{seg.text}</span>
                  ))}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function KeywordSessionResultSkeleton() {
  return (
    <div class={styles.skeleton}>
      <div class={styles.skeletonHeader}>
        <div class={`${styles.skeletonBar} ${styles.skeletonBadge}`} />
        <div class={`${styles.skeletonBar} ${styles.skeletonScore}`} />
      </div>
      <div class={`${styles.skeletonBar} ${styles.skeletonSummary}`} />
      <div class={`${styles.skeletonBar} ${styles.skeletonContent}`} />
    </div>
  )
}
