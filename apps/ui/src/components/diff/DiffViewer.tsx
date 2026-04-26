import { useState, useCallback, useEffect, useRef } from 'preact/hooks'
import type { ParsedFile, ParsedLine } from '../../hooks/useDiff'
import type { DiffCommentThread } from '../../hooks/useDiffComments'
import { FileCode, ChevronDown, ChevronUp, Files, ChevronsUpDown, ChevronsDownUp } from 'lucide-preact'
import { CopyButton } from '../ui/CopyButton'
import styles from './DiffViewer.module.css'

function fileId(path: string): string {
  return `diff-file-${path.replace(/[^a-zA-Z0-9]+/g, '-')}`
}

interface DiffViewerProps {
  files: ParsedFile[]
  isLoading?: boolean
  error?: string | null
  // Comment-related props
  getLineComments?: (path: string, line: number) => DiffCommentThread[]
  getLineCommentCount?: (path: string, line: number) => number
  onLineClick?: (path: string, line: number) => void
  // Inline comment input state
  activeCommentLine?: { path: string; line: number } | null
  commentInput?: string
  onCommentInputChange?: (value: string) => void
  onCommentSubmit?: () => void
  onCommentCancel?: () => void
  isSubmitting?: boolean
  // Expand/collapse control
  allExpanded?: boolean
  // View mode
  isUntrackedView?: boolean
  // Open file in editor
  onOpenInEditor?: (path: string) => void
}

function getStatusIcon(status: ParsedFile['status']): string {
  switch (status) {
    case 'added':
      return '+'
    case 'deleted':
      return '−'
    case 'renamed':
      return '→'
    default:
      return '●'
  }
}

function getStatusClass(status: ParsedFile['status']): string {
  switch (status) {
    case 'added':
      return styles.statusAdded
    case 'deleted':
      return styles.statusDeleted
    case 'renamed':
      return styles.statusRenamed
    default:
      return styles.statusModified
  }
}

interface FileHeaderProps {
  file: ParsedFile
  isCollapsed: boolean
  onToggle: () => void
  isUntrackedView?: boolean
  onOpenInEditor?: (path: string) => void
}

function FileHeader({ file, isCollapsed, onToggle, isUntrackedView, onOpenInEditor }: FileHeaderProps) {
  // For untracked view, always show as "added" (green +)
  const displayStatus = isUntrackedView ? 'added' : file.status

  return (
    <div role="button" tabIndex={0} class={styles.fileHeader} onClick={onToggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}>
      <span class={`${styles.collapseIcon} ${isCollapsed ? styles.collapsed : ''}`}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
      <span class={`${styles.statusIcon} ${getStatusClass(displayStatus)}`}>
        {getStatusIcon(displayStatus)}
      </span>
      <span class={styles.filePath}>
        {file.oldPath && file.oldPath !== file.path ? (
          <>
            <span class={styles.oldPath}>{file.oldPath}</span>
            <span class={styles.arrow}>→</span>
          </>
        ) : null}
        {file.path}
      </span>
      <CopyButton
        text={file.path}
        title="Copy file path"
        size={13}
        className={styles.copyPathButton}
        stopPropagation
      />
      {onOpenInEditor && (
        <span
          class={styles.openEditorButton}
          onClick={(e) => { e.stopPropagation(); onOpenInEditor(file.path) }}
          title="Open in Editor"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onOpenInEditor(file.path) } }}
        >
          <FileCode size={13} />
        </span>
      )}
      <span class={styles.stats}>
        {file.additions > 0 && <span class={styles.additions}>+{file.additions}</span>}
        {file.deletions > 0 && <span class={styles.deletions}>-{file.deletions}</span>}
      </span>
    </div>
  )
}

interface DiffLineProps {
  line: ParsedLine
  filePath: string
  commentCount: number
  onLineClick?: () => void
}

function DiffLine({ line, filePath, commentCount, onLineClick }: DiffLineProps) {
  const lineClass = styles[`line${line.type.charAt(0).toUpperCase()}${line.type.slice(1)}`] || styles.lineContext

  const handleClick = () => {
    // Only allow clicking on addition/deletion/context lines
    if (line.type !== 'hunk-header' && onLineClick) {
      onLineClick()
    }
  }

  if (line.type === 'hunk-header') {
    return (
      <div class={styles.hunkHeader}>
        <span class={styles.hunkLineNum} />
        <span class={styles.hunkLineNum} />
        <span class={styles.hunkContent}>{line.content}</span>
      </div>
    )
  }

  return (
    <div
      class={`${styles.diffLine} ${lineClass} ${onLineClick ? styles.clickable : ''}`}
      onClick={handleClick}
      data-path={filePath}
      data-line={line.lineIndex}
    >
      <span class={styles.lineNum}>
        {line.oldLineNumber ?? ''}
      </span>
      <span class={styles.lineNum}>
        {line.newLineNumber ?? ''}
      </span>
      <span class={styles.linePrefix}>
        {line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' '}
      </span>
      <span class={styles.lineContent}>
        {line.content || '\u00A0'}
      </span>
      {commentCount > 0 && (
        <span class={styles.lineCommentBadge} title={`${commentCount} comment(s)`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          {commentCount}
        </span>
      )}
    </div>
  )
}

interface InlineCommentInputProps {
  onSubmit: () => void
  onCancel: () => void
  value: string
  onChange: (value: string) => void
  isSubmitting?: boolean
}

function InlineCommentInput({ onSubmit, onCancel, value, onChange, isSubmitting }: InlineCommentInputProps) {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onSubmit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div class={styles.inlineComment}>
      <textarea
        class={styles.commentTextarea}
        placeholder="Add a comment... (Cmd+Enter to submit, Esc to cancel)"
        value={value}
        onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
        onKeyDown={handleKeyDown}
        autoFocus
        rows={3}
      />
      <div class={styles.commentActions}>
        <button
          type="button"
          class={styles.cancelButton}
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </button>
        <button
          type="button"
          class={styles.submitButton}
          onClick={onSubmit}
          disabled={!value.trim() || isSubmitting}
        >
          {isSubmitting ? 'Adding...' : 'Add comment'}
        </button>
      </div>
    </div>
  )
}

interface CommentThreadDisplayProps {
  thread: DiffCommentThread
}

function CommentThreadDisplay({ thread }: CommentThreadDisplayProps) {
  const formatTime = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  return (
    <div class={styles.commentThread}>
      <div class={styles.comment}>
        <div class={styles.commentMeta}>
          <span class={styles.commentAuthor}>
            {thread.author === 'user' ? 'You' : thread.author}
          </span>
          <span class={styles.commentTime}>{formatTime(thread.created_at)}</span>
        </div>
        <p class={styles.commentContent}>{thread.content}</p>
      </div>
      {thread.replies.map((reply) => (
        <div key={reply.id} class={`${styles.comment} ${styles.reply}`}>
          <div class={styles.commentMeta}>
            <span class={styles.commentAuthor}>
              {reply.author === 'user' ? 'You' : reply.author}
            </span>
            <span class={styles.commentTime}>{formatTime(reply.created_at)}</span>
          </div>
          <p class={styles.commentContent}>{reply.content}</p>
        </div>
      ))}
    </div>
  )
}

export function DiffViewer({
  files,
  isLoading,
  error,
  getLineComments,
  getLineCommentCount,
  onLineClick,
  activeCommentLine,
  commentInput = '',
  onCommentInputChange,
  onCommentSubmit,
  onCommentCancel,
  isSubmitting,
  allExpanded = true,
  isUntrackedView = false,
  onOpenInEditor,
}: DiffViewerProps) {
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())
  const [fileListCollapsed, setFileListCollapsed] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const fileListRef = useRef<HTMLDivElement>(null)

  // Sync with allExpanded prop
  useEffect(() => {
    if (allExpanded) {
      setCollapsedFiles(new Set())
    } else {
      setCollapsedFiles(new Set(files.map(f => f.path)))
    }
  }, [allExpanded, files])

  const toggleFile = useCallback((path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  const allFilesExpanded = collapsedFiles.size === 0
  const handleToggleAll = useCallback((e: Event) => {
    e.stopPropagation()
    setCollapsedFiles((prev) => {
      if (prev.size === 0) {
        return new Set(files.map(f => f.path))
      }
      return new Set()
    })
  }, [files])

  const handleJumpToFile = useCallback((path: string) => {
    // Expand target file if collapsed
    setCollapsedFiles((prev) => {
      if (!prev.has(path)) return prev
      const next = new Set(prev)
      next.delete(path)
      return next
    })
    // Scroll into view on the next frame (after layout)
    requestAnimationFrame(() => {
      const el = document.getElementById(fileId(path))
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [])

  if (isLoading) {
    return (
      <div class={styles.container}>
        <div class={styles.loading}>Loading diff...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div class={styles.container}>
        <div class={styles.error}>{error}</div>
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div class={styles.container}>
        <div class={styles.empty}>No changes in this commit</div>
      </div>
    )
  }

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0)
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0)

  return (
    <div class={styles.container} ref={containerRef}>
      {files.length > 1 && (
        <div class={styles.fileListSticky} ref={fileListRef}>
        <div class={styles.fileList}>
          <button
            type="button"
            class={styles.fileListHeader}
            onClick={() => setFileListCollapsed((v) => !v)}
          >
            <Files size={14} class={styles.fileListIcon} />
            <span class={styles.fileListTitle}>
              {files.length} file{files.length !== 1 ? 's' : ''} changed
            </span>
            <span class={styles.fileListTotals}>
              {totalAdditions > 0 && <span class={styles.additions}>+{totalAdditions}</span>}
              {totalDeletions > 0 && <span class={styles.deletions}>-{totalDeletions}</span>}
            </span>
            <span
              role="button"
              tabIndex={0}
              class={styles.fileListAction}
              onClick={handleToggleAll}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleToggleAll(e as unknown as Event) } }}
              title={allFilesExpanded ? 'Collapse all files' : 'Expand all files'}
            >
              {allFilesExpanded ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
              <span class={styles.fileListActionLabel}>
                {allFilesExpanded ? 'Collapse all' : 'Expand all'}
              </span>
            </span>
            <span class={styles.fileListToggleLabel}>
              {fileListCollapsed ? 'Show' : 'Hide'}
            </span>
            <span class={styles.fileListToggleIcon}>
              {fileListCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </span>
          </button>
          {!fileListCollapsed && (
            <ul class={styles.fileListItems}>
              {files.map((file) => {
                const displayStatus = isUntrackedView ? 'added' : file.status
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      class={styles.fileListItem}
                      onClick={() => handleJumpToFile(file.path)}
                      title={file.path}
                    >
                      <span class={`${styles.fileListStatus} ${getStatusClass(displayStatus)}`}>
                        {getStatusIcon(displayStatus)}
                      </span>
                      <span class={styles.fileListPath}>{file.path}</span>
                      <span class={styles.fileListStats}>
                        {file.additions > 0 && <span class={styles.additions}>+{file.additions}</span>}
                        {file.deletions > 0 && <span class={styles.deletions}>-{file.deletions}</span>}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        </div>
      )}
      {files.map((file) => {
        const isCollapsed = collapsedFiles.has(file.path)

        return (
          <div key={file.path} id={fileId(file.path)} class={styles.file}>
            <FileHeader
              file={file}
              isCollapsed={isCollapsed}
              onToggle={() => toggleFile(file.path)}
              isUntrackedView={isUntrackedView}
              onOpenInEditor={onOpenInEditor}
            />

            {!isCollapsed && (
              <div class={styles.fileContent}>
                {file.hunks.map((hunk, hunkIndex) => (
                  <div key={hunkIndex} class={styles.hunk}>
                    {hunk.lines.map((line) => {
                      // Use lineIndex for comment anchoring (unique per line in diff)
                      const anchorLine = line.lineIndex
                      const commentCount = getLineCommentCount?.(file.path, anchorLine) ?? 0
                      const lineComments = getLineComments?.(file.path, anchorLine) ?? []
                      const isActiveComment =
                        activeCommentLine?.path === file.path &&
                        activeCommentLine?.line === anchorLine

                      return (
                        <div key={line.lineIndex}>
                          <DiffLine
                            line={line}
                            filePath={file.path}
                            commentCount={commentCount}
                            onLineClick={
                              onLineClick && line.type !== 'hunk-header'
                                ? () => onLineClick(file.path, anchorLine)
                                : undefined
                            }
                          />

                          {/* Show existing comments for this line */}
                          {lineComments.map((thread) => (
                            <CommentThreadDisplay key={thread.id} thread={thread} />
                          ))}

                          {/* Show inline comment input if this line is active */}
                          {isActiveComment && onCommentSubmit && onCommentCancel && onCommentInputChange && (
                            <InlineCommentInput
                              value={commentInput}
                              onChange={onCommentInputChange}
                              onSubmit={onCommentSubmit}
                              onCancel={onCommentCancel}
                              isSubmitting={isSubmitting}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
