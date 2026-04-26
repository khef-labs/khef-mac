import { useState, useEffect, useRef } from 'preact/hooks'
import { Copy, Check } from 'lucide-preact'
import type { Commit } from '../../types'
import styles from './CommitList.module.css'

interface CommitListProps {
  commits: Commit[]
  selectedSha: string | null
  onSelectCommit: (sha: string) => void
  isLoading?: boolean
  hasMore?: boolean
  onLoadMore?: () => void
  hasUncommitted?: boolean
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)
  const diffWeeks = Math.floor(diffDays / 7)
  const diffMonths = Math.floor(diffDays / 30)

  if (diffSecs < 60) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffWeeks < 4) return `${diffWeeks}w ago`
  return `${diffMonths}mo ago`
}

export function CommitList({
  commits,
  selectedSha,
  onSelectCommit,
  isLoading,
  hasMore,
  onLoadMore,
  hasUncommitted,
}: CommitListProps) {
  const [copiedSha, setCopiedSha] = useState<string | null>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)
  const hasScrolled = useRef(false)

  // Scroll the selected commit into view once after commits load
  useEffect(() => {
    if (hasScrolled.current || !selectedSha || commits.length === 0) return
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
      hasScrolled.current = true
    }
  }, [commits, selectedSha])

  const handleCopy = async (e: Event, sha: string) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(sha)
      setCopiedSha(sha)
      setTimeout(() => setCopiedSha(null), 2000)
    } catch {
      // ignore
    }
  }

  if (isLoading && commits.length === 0) {
    return (
      <div class={styles.container}>
        <div class={styles.loading}>Loading commits...</div>
      </div>
    )
  }

  if (commits.length === 0) {
    return (
      <div class={styles.container}>
        <div class={styles.empty}>No commits found</div>
      </div>
    )
  }

  return (
    <div class={styles.container}>
      <div class={styles.list}>
        {hasUncommitted && (
          <button
            type="button"
            class={`${styles.commitItem} ${styles.uncommitted} ${selectedSha === 'uncommitted' ? styles.selected : ''}`}
            onClick={() => onSelectCommit('uncommitted')}
          >
            <span
              class={`${styles.indicator} ${selectedSha === 'uncommitted' ? styles.indicatorActive : ''}`}
            />
            <div class={styles.commitContent}>
              <span class={styles.uncommittedLabel}>Uncommitted changes</span>
            </div>
          </button>
        )}
        {commits.map((commit) => {
          const initial = commit.author?.trim().charAt(0).toUpperCase() || '?'
          return (
            <button
              key={commit.sha}
              ref={selectedSha === commit.sha ? selectedRef : undefined}
              type="button"
              class={`${styles.commitItem} ${selectedSha === commit.sha ? styles.selected : ''}`}
              onClick={() => onSelectCommit(commit.sha)}
            >
              <span
                class={`${styles.indicator} ${selectedSha === commit.sha ? styles.indicatorActive : ''}`}
              />
              <div class={styles.commitContent}>
                <p class={styles.message}>{commit.message}</p>
                <div class={styles.commitMeta}>
                  <span class={styles.avatar} title={commit.author}>{initial}</span>
                  <span class={styles.author}>{commit.author}</span>
                  <span class={styles.metaSep}>·</span>
                  <code class={styles.sha}>{commit.short_sha || commit.sha?.slice(0, 7)}</code>
                  <button
                    type="button"
                    class={styles.copyButton}
                    onClick={(e) => handleCopy(e, commit.sha)}
                    title="Copy full SHA"
                  >
                    {copiedSha === commit.sha ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                  <span class={styles.metaSep}>·</span>
                  <span class={styles.time}>{formatRelativeTime(commit.date)}</span>
                  {commit.stats && (commit.stats.insertions > 0 || commit.stats.deletions > 0) && (
                    <>
                      <span class={styles.metaSep}>·</span>
                      {commit.stats.insertions > 0 && (
                        <span class={styles.statAdd}>+{commit.stats.insertions}</span>
                      )}
                      {commit.stats.deletions > 0 && (
                        <span class={styles.statDel}>−{commit.stats.deletions}</span>
                      )}
                    </>
                  )}
                </div>
              </div>

              {commit.comment_count !== undefined && commit.comment_count > 0 && (
                <div class={styles.commentBadge} title={`${commit.comment_count} comment(s)`}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  <span>{commit.comment_count}</span>
                </div>
              )}
            </button>
          )
        })}
      </div>

      <div class={styles.footer}>
        <span class={styles.count}>{commits.length} commits</span>
        {hasMore && (
          <button
            type="button"
            class={styles.loadMore}
            onClick={onLoadMore}
            disabled={isLoading}
          >
            {isLoading ? 'Loading...' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  )
}
