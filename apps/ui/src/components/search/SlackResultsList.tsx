import { SearchX, Hash, MessageCircle } from 'lucide-preact'
import clsx from 'clsx'
import type { SlackSearchResult } from '../../types'
import styles from './SlackResultsList.module.css'

interface SlackResultsListProps {
  results: SlackSearchResult[]
  isLoading: boolean
  hasQuery: boolean
}

function extractChannel(metadata: Record<string, unknown>): string | null {
  return (metadata?.channel as string) || null
}

function extractWorkspace(metadata: Record<string, unknown>): string | null {
  return (metadata?.workspace as string) || null
}

export function SlackResultsList({ results, isLoading, hasQuery }: SlackResultsListProps) {
  if (isLoading) {
    return (
      <div class={styles.list}>
        {Array.from({ length: 3 }).map((_, i) => (
          <SlackResultSkeleton key={i} />
        ))}
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <div class={styles.empty}>
        <SearchX class={styles.emptyIcon} size={48} />
        <h2 class={styles.emptyTitle}>
          {hasQuery ? 'No Slack messages found' : 'Search Slack'}
        </h2>
        <p class={styles.emptyText}>
          {hasQuery
            ? 'Try adjusting your search query to find relevant messages.'
            : 'Enter a search term to find messages in ingested Slack history.'}
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
          const channel = extractChannel(result.metadata)
          const workspace = extractWorkspace(result.metadata)
          return (
            <div key={`${result.document_id}-${result.chunk_index}-${i}`} class={styles.card}>
              <div class={styles.cardHeader}>
                {channel && (
                  <span class={styles.channelBadge}>
                    <Hash size={12} />
                    {channel}
                  </span>
                )}
                {workspace && (
                  <span class={styles.workspaceBadge}>{workspace}</span>
                )}
                <span class={styles.score}>
                  {(result.score * 100).toFixed(0)}% match
                </span>
                <span class={styles.chunk}>
                  chunk {result.chunk_index + 1}
                </span>
              </div>
              <div class={styles.content}>
                <MessageCircle size={14} class={styles.contentIcon} />
                <span class={styles.contentText}>{result.content}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SlackResultSkeleton() {
  return (
    <div class={styles.skeleton}>
      <div class={styles.skeletonHeader}>
        <div class={clsx(styles.skeletonBar, styles.skeletonBadge)} />
        <div class={clsx(styles.skeletonBar, styles.skeletonScore)} />
      </div>
      <div class={clsx(styles.skeletonBar, styles.skeletonContent)} />
    </div>
  )
}
