import { useMemo, useState } from 'preact/hooks'
import { SearchX, FileCode, GitBranch } from 'lucide-preact'
import clsx from 'clsx'
import type { SourceCodeSearchResult } from '../../types'
import styles from './SourceCodeResultsList.module.css'

interface SourceCodeResultsListProps {
  results: SourceCodeSearchResult[]
  isLoading: boolean
  hasQuery: boolean
  groupByFile?: boolean
  maxPerFile?: number
  onResultClick?: (result: SourceCodeSearchResult) => void
  onOpenInEditor?: (result: SourceCodeSearchResult) => void
  onOpenInNewTab?: (result: SourceCodeSearchResult) => void
}

function extractFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath
}

function extractDir(filePath: string): string {
  const parts = filePath.split('/')
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/')
}

function SourceCodeResultCard({
  result,
  onClick,
  onContextMenu,
}: {
  result: SourceCodeSearchResult
  onClick?: (result: SourceCodeSearchResult) => void
  onContextMenu?: (event: MouseEvent, result: SourceCodeSearchResult) => void
}) {
  const fileName = extractFileName(result.file_path)
  const dir = extractDir(result.file_path)
  const repo = (result.metadata?.repoName as string) || (result.metadata?.repo as string) || ''
  const clickable = typeof onClick === 'function'

  const handleClick = () => {
    onClick?.(result)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!clickable) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick?.(result)
    }
  }

  return (
    <div
      class={clsx(styles.card, clickable && styles.cardClickable)}
      onClick={clickable ? handleClick : undefined}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, result) : undefined}
      onKeyDown={clickable ? handleKeyDown : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      title={clickable ? 'Open result (right-click for options)' : undefined}
    >
      <div class={styles.cardHeader}>
        <span class={styles.fileBadge}>
          <FileCode size={12} />
          {fileName}
        </span>
        {result.language && (
          <span class={styles.langBadge}>
            {result.language}
          </span>
        )}
        {repo && (
          <span class={styles.repoBadge}>
            <GitBranch size={12} />
            {repo}
          </span>
        )}
        <span class={styles.score}>
          {(result.score * 100).toFixed(0)}% match
        </span>
        <span class={styles.chunkLabel}>chunk {result.chunk_index}</span>
      </div>
      {dir && (
        <div class={styles.filePath}>{dir}/</div>
      )}
      <pre class={styles.codeBlock}>
        <code>{result.content}</code>
      </pre>
    </div>
  )
}

export function SourceCodeResultsList({
  results,
  isLoading,
  hasQuery,
  groupByFile = true,
  maxPerFile = 1,
  onResultClick,
  onOpenInEditor,
  onOpenInNewTab,
}: SourceCodeResultsListProps) {
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({})
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; result: SourceCodeSearchResult } | null>(null)

  const handleContextMenu = (event: MouseEvent, result: SourceCodeSearchResult) => {
    event.preventDefault()
    setContextMenu({ x: event.clientX, y: event.clientY, result })
  }

  const closeContextMenu = () => setContextMenu(null)
  const groups = useMemo(() => {
    const byFile = new Map<string, SourceCodeSearchResult[]>()
    const order: string[] = []
    for (const r of results) {
      if (!byFile.has(r.file_path)) {
        byFile.set(r.file_path, [])
        order.push(r.file_path)
      }
      byFile.get(r.file_path)!.push(r)
    }
    return order.map((filePath) => ({ filePath, results: byFile.get(filePath) || [] }))
  }, [results])

  if (isLoading) {
    return (
      <div class={styles.list}>
        {Array.from({ length: 3 }).map((_, i) => (
          <SourceCodeResultSkeleton key={i} />
        ))}
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <div class={styles.empty}>
        <SearchX class={styles.emptyIcon} size={48} />
        <h2 class={styles.emptyTitle}>
          {hasQuery ? 'No source code found' : 'Search source code'}
        </h2>
        <p class={styles.emptyText}>
          {hasQuery
            ? 'Try adjusting your search query to find relevant code.'
            : 'Enter a search term to find indexed source code.'}
        </p>
      </div>
    )
  }

  return (
    <div onClick={contextMenu ? closeContextMenu : undefined}>
      <div class={styles.meta}>
        <span>
          {groupByFile
            ? `Found ${groups.length} file match${groups.length !== 1 ? 'es' : ''} (${results.length} chunks)`
            : `Found ${results.length} result${results.length !== 1 ? 's' : ''}`}
        </span>
      </div>
      <div class={styles.list}>
        {!groupByFile && results.map((result, i) => (
          <SourceCodeResultCard
            key={`${result.file_path}-${result.chunk_index}-${i}`}
            result={result}
            onClick={onResultClick}
            onContextMenu={handleContextMenu}
          />
        ))}
        {groupByFile && groups.map((group) => {
          const visible = group.results.slice(0, Math.max(1, maxPerFile))
          const rest = group.results.slice(Math.max(1, maxPerFile))
          const expanded = !!expandedFiles[group.filePath]
          return (
            <div key={group.filePath} class={styles.group}>
              {visible.map((result, i) => (
                <SourceCodeResultCard
                  key={`${result.file_path}-${result.chunk_index}-visible-${i}`}
                  result={result}
                  onClick={onResultClick}
                  onContextMenu={handleContextMenu}
                />
              ))}
              {rest.length > 0 && (
                <div class={styles.groupFooter}>
                  <button
                    type="button"
                    class={styles.expandButton}
                    onClick={() =>
                      setExpandedFiles((prev) => ({ ...prev, [group.filePath]: !prev[group.filePath] }))
                    }
                  >
                    {expanded ? `Hide ${rest.length} more match${rest.length !== 1 ? 'es' : ''}` : `Show ${rest.length} more match${rest.length !== 1 ? 'es' : ''}`}
                  </button>
                  <span class={styles.groupChunks}>
                    chunks: {rest.map((r) => r.chunk_index).join(', ')}
                  </span>
                </div>
              )}
              {expanded && rest.length > 0 && (
                <div class={styles.groupChildren}>
                  {rest.map((result, i) => (
                    <SourceCodeResultCard
                      key={`${result.file_path}-${result.chunk_index}-${i}`}
                      result={result}
                      onClick={onResultClick}
                      onContextMenu={handleContextMenu}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {contextMenu && (
        <div
          class={styles.contextMenu}
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            class={styles.contextMenuItem}
            onClick={() => {
              onOpenInEditor?.(contextMenu.result)
              closeContextMenu()
            }}
          >
            Open in Editor
          </button>
          <button
            type="button"
            class={styles.contextMenuItem}
            onClick={() => {
              onOpenInNewTab?.(contextMenu.result)
              closeContextMenu()
            }}
          >
            Open in New Tab
          </button>
        </div>
      )}
    </div>
  )
}

function SourceCodeResultSkeleton() {
  return (
    <div class={styles.skeleton}>
      <div class={styles.skeletonHeader}>
        <div class={clsx(styles.skeletonBar, styles.skeletonBadge)} />
        <div class={clsx(styles.skeletonBar, styles.skeletonLang)} />
        <div class={clsx(styles.skeletonBar, styles.skeletonScore)} />
      </div>
      <div class={clsx(styles.skeletonBar, styles.skeletonPath)} />
      <div class={clsx(styles.skeletonBar, styles.skeletonCode)} />
    </div>
  )
}
