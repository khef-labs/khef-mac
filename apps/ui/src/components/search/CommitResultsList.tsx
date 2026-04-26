import { Link } from 'wouter-preact'
import { SearchX, GitCommit, User, Calendar, GitBranch } from 'lucide-preact'
import clsx from 'clsx'
import type { CommitSearchResult } from '../../types'
import styles from './CommitResultsList.module.css'

interface CommitResultsListProps {
  results: CommitSearchResult[]
  isLoading: boolean
  hasQuery: boolean
  repoProjectMap?: Record<string, string>
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return dateStr
  }
}

export function CommitResultsList({ results, isLoading, hasQuery, repoProjectMap = {} }: CommitResultsListProps) {
  if (isLoading) {
    return (
      <div class={styles.list}>
        {Array.from({ length: 3 }).map((_, i) => (
          <CommitResultSkeleton key={i} />
        ))}
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <div class={styles.empty}>
        <SearchX class={styles.emptyIcon} size={48} />
        <h2 class={styles.emptyTitle}>
          {hasQuery ? 'No commits found' : 'Search commits'}
        </h2>
        <p class={styles.emptyText}>
          {hasQuery
            ? 'Try adjusting your search query to find relevant commits.'
            : 'Enter a search term to find commits by message content.'}
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
        {results.map((result, i) => {
          const projectHandle = result.repo ? repoProjectMap[result.repo] : undefined
          const diffUrl = projectHandle ? `/projects/${projectHandle}/diff?commit=${result.sha}` : undefined

          const card = (
            <div class={styles.card}>
              <div class={styles.cardHeader}>
                <span class={styles.shaBadge}>
                  <GitCommit size={12} />
                  {result.short_sha}
                </span>
                {result.repo && (
                  <span class={styles.repoBadge}>
                    <GitBranch size={12} />
                    {result.repo}
                  </span>
                )}
                <span class={styles.score}>
                  {(result.score * 100).toFixed(0)}% match
                </span>
              </div>
              <div class={styles.message}>{result.message}</div>
              <div class={styles.cardFooter}>
                <span class={styles.author}>
                  <User size={12} />
                  {result.author}
                </span>
                <span class={styles.date}>
                  <Calendar size={12} />
                  {formatDate(result.date)}
                </span>
              </div>
            </div>
          )

          const key = `${result.sha}-${i}`
          return diffUrl ? (
            <Link key={key} href={diffUrl} class={styles.cardLink}>
              {card}
            </Link>
          ) : <div key={key}>{card}</div>
        })}
      </div>
    </div>
  )
}

function CommitResultSkeleton() {
  return (
    <div class={styles.skeleton}>
      <div class={styles.skeletonHeader}>
        <div class={clsx(styles.skeletonBar, styles.skeletonBadge)} />
        <div class={clsx(styles.skeletonBar, styles.skeletonScore)} />
      </div>
      <div class={clsx(styles.skeletonBar, styles.skeletonMessage)} />
      <div class={styles.skeletonFooter}>
        <div class={clsx(styles.skeletonBar, styles.skeletonAuthor)} />
        <div class={clsx(styles.skeletonBar, styles.skeletonDate)} />
      </div>
    </div>
  )
}
