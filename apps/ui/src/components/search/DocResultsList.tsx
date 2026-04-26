import { SearchX, FileText, Tag, FolderOpen, ExternalLink } from 'lucide-preact'
import clsx from 'clsx'
import type { DocSearchResult } from '../../types'
import styles from './DocResultsList.module.css'

const BROWSER_VIEWABLE = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'])

function canOpenInBrowser(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.')
  if (dot === -1) return false
  return BROWSER_VIEWABLE.has(filePath.substring(dot).toLowerCase())
}

interface DocResultsListProps {
  results: DocSearchResult[]
  isLoading: boolean
  hasQuery: boolean
  onOpenInEditor?: (result: DocSearchResult) => void
}

function basename(filePath: string): string {
  const parts = filePath.split('/')
  return parts[parts.length - 1] || filePath
}

export function DocResultsList({ results, isLoading, hasQuery, onOpenInEditor }: DocResultsListProps) {
  if (isLoading) {
    return (
      <div class={styles.list}>
        {Array.from({ length: 3 }).map((_, i) => (
          <DocResultSkeleton key={i} />
        ))}
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <div class={styles.empty}>
        <SearchX class={styles.emptyIcon} size={48} />
        <h2 class={styles.emptyTitle}>
          {hasQuery ? 'No documents found' : 'Search Documents'}
        </h2>
        <p class={styles.emptyText}>
          {hasQuery
            ? 'Try adjusting your search query to find relevant documents.'
            : 'Enter a search term to find content in indexed documents (markdown, PDF, text).'}
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
          <div key={`${result.file_path}-${i}`} class={styles.card}>
            <div class={styles.cardHeader}>
              <span class={styles.fileName}>
                <FileText size={14} />
                {result.title || basename(result.file_path)}
              </span>
              {result.file_type && (
                <span class={styles.typeBadge}>.{result.file_type}</span>
              )}
              {result.project_handle && (
                <span class={styles.projectBadge}>
                  <FolderOpen size={11} />
                  {result.project_handle}
                </span>
              )}
              <span class={styles.score}>
                {(result.score * 100).toFixed(0)}% match
              </span>
              <button
                class={styles.openBtn}
                title={canOpenInBrowser(result.file_path) ? 'Open in browser' : 'Open in editor'}
                onClick={(e) => {
                  e.stopPropagation()
                  if (canOpenInBrowser(result.file_path)) {
                    window.open(`/api/files/local?path=${encodeURIComponent(result.file_path)}`, '_blank')
                  } else {
                    onOpenInEditor?.(result)
                  }
                }}
              >
                <ExternalLink size={13} />
              </button>
            </div>
            {result.tags.length > 0 && (
              <div class={styles.tags}>
                {result.tags.map((tag) => (
                  <span key={tag} class={styles.tag}>
                    <Tag size={10} />
                    {tag}
                  </span>
                ))}
              </div>
            )}
            <div class={styles.content}>
              <span class={styles.contentText}>{result.content}</span>
            </div>
            {result.source_path && result.source_path !== result.file_path && (
              <div class={styles.path}>{result.source_path}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function DocResultSkeleton() {
  return (
    <div class={styles.skeleton}>
      <div class={styles.skeletonHeader}>
        <div class={clsx(styles.skeletonBar, styles.skeletonName)} />
        <div class={clsx(styles.skeletonBar, styles.skeletonBadge)} />
        <div class={clsx(styles.skeletonBar, styles.skeletonScore)} />
      </div>
      <div class={clsx(styles.skeletonBar, styles.skeletonContent)} />
    </div>
  )
}
