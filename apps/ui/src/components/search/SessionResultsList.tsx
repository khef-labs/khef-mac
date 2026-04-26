import { useLocation, useSearch } from 'wouter-preact'
import { SearchX, MessageSquare, Bot, Brain } from 'lucide-preact'
import clsx from 'clsx'
import { getSyncedSession } from '../../lib/api'
import type { SessionSearchResult } from '../../types'
import styles from './SessionResultsList.module.css'

interface SessionResultsListProps {
  results: SessionSearchResult[]
  isLoading: boolean
  hasQuery: boolean
}

// Decode project dir to readable path
function decodeProjectDir(dir: string): string {
  return dir.replace(/-/g, '/').replace(/^\//, '')
}

// Parse content into styled segments
function parseContent(content: string): { type: 'user' | 'assistant' | 'thinking'; text: string }[] {
  const segments: { type: 'user' | 'assistant' | 'thinking'; text: string }[] = []
  const lines = content.split('\n')
  let currentType: 'user' | 'assistant' | 'thinking' = 'assistant'
  let currentText: string[] = []

  for (const line of lines) {
    if (line.startsWith('User:')) {
      if (currentText.length > 0) {
        segments.push({ type: currentType, text: currentText.join('\n') })
      }
      currentType = 'user'
      currentText = [line.slice(5).trim()]
    } else if (line.startsWith('Assistant:')) {
      if (currentText.length > 0) {
        segments.push({ type: currentType, text: currentText.join('\n') })
      }
      currentType = 'assistant'
      currentText = [line.slice(10).trim()]
    } else if (line.startsWith('Thinking:')) {
      if (currentText.length > 0) {
        segments.push({ type: currentType, text: currentText.join('\n') })
      }
      currentType = 'thinking'
      currentText = [line.slice(9).trim()]
    } else {
      currentText.push(line)
    }
  }

  if (currentText.length > 0) {
    segments.push({ type: currentType, text: currentText.join('\n') })
  }

  return segments.filter(s => s.text.trim() && s.text.trim() !== '(no content)')
}

export function SessionResultsList({ results, isLoading, hasQuery }: SessionResultsListProps) {
  const [, setLocation] = useLocation()
  const searchString = useSearch()

  const handleResultClick = async (result: SessionSearchResult) => {
    const from = encodeURIComponent(searchString ? `/search?${searchString}` : '/search')

    // Use db_id directly if available from enrichment
    if (result.db_id) {
      setLocation(`/sessions/${result.db_id}?from=${from}`)
      return
    }

    // Fall back to lookup
    try {
      const data = await getSyncedSession(result.session_id, false)
      if (data.session) {
        setLocation(`/sessions/${data.session.id}?from=${from}`)
        return
      }
    } catch {
      // Session not synced yet — fall back to raw file view
    }

    const handle = result.assistant_handle || 'claude-code'
    setLocation(`/assistants/${handle}/sessions/${encodeURIComponent(result.project_dir)}/${result.session_id}?from=${from}`)
  }

  if (isLoading) {
    return (
      <div class={styles.list}>
        {Array.from({ length: 3 }).map((_, i) => (
          <SessionResultSkeleton key={i} />
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
              <span class={styles.projectBadge}>
                {decodeProjectDir(result.project_dir).split('/').pop()}
              </span>
              {(result.nickname || result.session_id) && (
                <span class={styles.sessionLabel}>
                  {result.nickname || result.session_id.slice(0, 8)}
                </span>
              )}
              <span class={styles.score}>
                {(result.score * 100).toFixed(0)}% match
              </span>
              <span class={styles.chunk}>
                chunk {result.chunk_index + 1}/{result.chunk_count}
              </span>
            </div>
            {result.summary && (
              <div class={styles.summary}>{result.summary}</div>
            )}
            <div class={styles.content}>
              {parseContent(result.content).map((segment, j) => (
                <div key={j} class={clsx(styles.segment, styles[segment.type])}>
                  <span class={styles.segmentIcon}>
                    {segment.type === 'user' && <MessageSquare size={14} />}
                    {segment.type === 'assistant' && <Bot size={14} />}
                    {segment.type === 'thinking' && <Brain size={14} />}
                  </span>
                  <span class={styles.segmentText}>{segment.text}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SessionResultSkeleton() {
  return (
    <div class={styles.skeleton}>
      <div class={styles.skeletonHeader}>
        <div class={clsx(styles.skeletonBar, styles.skeletonBadge)} />
        <div class={clsx(styles.skeletonBar, styles.skeletonScore)} />
      </div>
      <div class={clsx(styles.skeletonBar, styles.skeletonSummary)} />
      <div class={clsx(styles.skeletonBar, styles.skeletonContent)} />
    </div>
  )
}
