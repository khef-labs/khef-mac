import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import { Link, useLocation } from 'wouter-preact'
import { Download, Trash2, ChevronRight, ChevronLeft, FileText, Search, X } from 'lucide-preact'
import clsx from 'clsx'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeHighlight from 'rehype-highlight'
import rehypeStringify from 'rehype-stringify'
import { htmlSanitizeSchema, rehypeSanitize } from '../lib/markdown'
import {
  getSessionProjects,
  getSessionTranscript,
  getSessionContext,
  deleteSession,
  getSyncedSession,
} from '../lib/api'
import { formatBytes, formatRelativeTime } from '../lib/format'
import { exportSession, triggerDownload } from '../lib/sessionExport'
import {
  getNavContext,
  clearNavContext,
  updateNavIndex,
  getPrevMemoryId,
  getNextMemoryId,
} from '../lib/navContext'
import type { SessionEntry, SessionContentBlock } from '../types'
import { ArchiveBadge } from '../components/session'
import { ConfirmModal, CopyButton, useToast } from '../components/ui'
import { SessionContextMenu } from '../components/shared/SessionContextMenu'
import styles from './SessionFilePage.module.css'

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, htmlSanitizeSchema)
  .use(rehypeHighlight, { detect: true, ignoreMissing: true })
  .use(rehypeStringify)

async function renderMarkdown(content: string): Promise<string> {
  const file = await markdownProcessor.process(content)
  return String(file)
}

interface Props {
  projectId?: string
  dirName?: string
  handle?: string
  sessionId: string
}

type ViewMode = 'formatted' | 'json'
type SortOrder = 'desc' | 'asc'


export function SessionFilePage({ projectId, dirName: dirNameProp, handle = 'claude-code', sessionId }: Props) {
  const { showToast } = useToast()
  const [, setLocation] = useLocation()

  const [, setProjectName] = useState<string>('')
  const [dirName, setDirName] = useState<string | null>(dirNameProp || null)
  const [entries, setEntries] = useState<SessionEntry[]>([])
  const [sessionMeta, setSessionMeta] = useState<{
    size: number
    entry_count: number
    duration?: string
    source?: 'original' | 'backup'
  } | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('formatted')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set())
  const [renderedHtml, setRenderedHtml] = useState<Map<string, string>>(new Map())
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [showUser, setShowUser] = useState(true)
  const [showAssistant, setShowAssistant] = useState(true)
  const [showTools, setShowTools] = useState(false)
  const [showThinking, setShowThinking] = useState(false)
  const [navPosition, setNavPosition] = useState<{ current: number; total: number } | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const pageSize = 500
  const [syncedSessionId, setSyncedSessionId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [contextMenu, setContextMenu] = useState<{ entryUuid: string; position: { x: number; y: number } } | null>(null)


  // Sync navigation context
  useEffect(() => {
    const context = getNavContext()
    if (!context) {
      setNavPosition(null)
      return
    }
    const currentIndex = context.ids.indexOf(sessionId)
    if (currentIndex === -1) {
      clearNavContext()
      setNavPosition(null)
      return
    }
    if (currentIndex !== context.currentIndex) {
      updateNavIndex(currentIndex)
    }
    setNavPosition({ current: currentIndex + 1, total: context.ids.length })
  }, [sessionId])

  const buildSessionHref = useCallback((id: string) => {
    if (projectId) return `/projects/${projectId}/sessions/files/${encodeURIComponent(id)}`
    if (dirName) return `/assistants/${handle}/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(id)}`
    return ''
  }, [projectId, dirName, handle])

  const navigatePrev = useCallback(() => {
    const prevId = getPrevMemoryId()
    if (prevId) setLocation(buildSessionHref(prevId))
  }, [setLocation, buildSessionHref])

  const navigateNext = useCallback(() => {
    const nextId = getNextMemoryId()
    if (nextId) setLocation(buildSessionHref(nextId))
  }, [setLocation, buildSessionHref])

  // Resolve project to dir_name (skip if dirName provided directly)
  useEffect(() => {
    if (dirNameProp) {
      setProjectName(decodeURIComponent(dirNameProp))
      return
    }
    if (!projectId) {
      setError('No project or directory specified')
      setIsLoading(false)
      return
    }

    let mounted = true

    Promise.all([
      getSessionContext(projectId).catch(() => null),
      getSessionProjects('claude-code').catch(() => null),
    ]).then(([ctx, sessionData]) => {
      if (!mounted) return

      setProjectName(ctx?.project?.display_name || ctx?.project?.name || projectId)

      if (sessionData?.projects) {
        const match = sessionData.projects.find(
          (p) => p.matched_project?.id === projectId || p.matched_project?.handle === projectId
        )
        if (match) {
          setDirName(match.dir_name)
        } else {
          setError('No session directory found for this project')
          setIsLoading(false)
        }
      } else {
        setError('Failed to resolve session directory')
        setIsLoading(false)
      }
    })

    return () => { mounted = false }
  }, [projectId, dirNameProp])

  // Load transcript - fetch all entries at once
  const loadTranscript = useCallback(async () => {
    if (!dirName) return

    setIsLoading(true)
    setError(null)
    setCurrentPage(1) // Reset to first page when loading new session
    try {
      // Fetch all entries (no pagination limit)
      const data = await getSessionTranscript('claude-code', dirName, sessionId, {
        limit: 10000, // High limit to get all entries
        offset: 0,
      })
      const fetched = data.session.entries || []
      setEntries(sortOrder === 'desc' ? [...fetched].reverse() : fetched)
      // Compute session duration from oldest to newest entry
      const timestamps = fetched.map(e => e.timestamp).filter(Boolean).sort()
      let duration: string | undefined
      if (timestamps.length >= 2) {
        const oldest = new Date(timestamps[0]!).getTime()
        const newest = new Date(timestamps[timestamps.length - 1]!).getTime()
        const diffMs = newest - oldest
        const diffMins = Math.floor(diffMs / 60000)
        const diffHours = Math.floor(diffMins / 60)
        const remainingMins = diffMins % 60
        if (diffHours > 0) {
          duration = remainingMins > 0 ? `${diffHours}h ${remainingMins}m` : `${diffHours}h`
        } else if (diffMins > 0) {
          duration = `${diffMins}m`
        } else {
          duration = '<1m'
        }
      }
      setSessionMeta({
        size: data.session.size,
        entry_count: data.session.entry_count,
        duration,
        source: data.session.source,
      })
    } catch (err: any) {
      setError(err.message || 'Failed to load session transcript')
    } finally {
      setIsLoading(false)
    }
  }, [dirName, sessionId, sortOrder])

  useEffect(() => {
    loadTranscript()
  }, [loadTranscript])

  // Look up the synced session for "View Transcript" link
  useEffect(() => {
    let mounted = true
    getSyncedSession(sessionId, false)
      .then((data) => {
        if (mounted && data.session) setSyncedSessionId(data.session.id)
      })
      .catch(() => {})
    return () => { mounted = false }
  }, [sessionId])

  // Pre-render markdown for text blocks in formatted mode
  useEffect(() => {
    if (viewMode !== 'formatted') return

    const textEntries = entries.filter(
      (e) => (e.type === 'user' || e.type === 'assistant') && e.message
    )

    const renderAll = async () => {
      const newMap = new Map<string, string>()
      for (const entry of textEntries) {
        const key = entry.uuid || `${entry.type}-${entries.indexOf(entry)}`
        const msg = entry.message
        if (!msg) continue

        if (typeof msg.content === 'string') {
          try {
            newMap.set(key, await renderMarkdown(msg.content))
          } catch {
            newMap.set(key, msg.content)
          }
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              const blockKey = `${key}-text-${msg.content.indexOf(block)}`
              try {
                newMap.set(blockKey, await renderMarkdown(block.text))
              } catch {
                newMap.set(blockKey, block.text)
              }
            }
          }
        }
      }
      setRenderedHtml((prev) => {
        const merged = new Map(prev)
        for (const [k, v] of newMap) merged.set(k, v)
        return merged
      })
    }

    renderAll()
  }, [entries, viewMode])

  const toggleExpanded = (id: string) => {
    setExpandedEntries((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleDelete = async () => {
    if (!dirName) return
    try {
      await deleteSession('claude-code', dirName, sessionId)
      const backUrl = projectId
        ? `/projects/${projectId}/sessions`
        : `/assistants/${handle}/sessions/${encodeURIComponent(dirName)}`
      setLocation(backUrl)
    } catch (err: any) {
      setError(err.message || 'Failed to delete session')
    } finally {
      setShowDeleteConfirm(false)
    }
  }

  const handleExport = (mode: 'full' | 'compact', format: 'md' | 'txt') => {
    setShowExportMenu(false)

    // All entries are already loaded
    const summaryEntry = entries.find((e) => e.type === 'summary')
    const title = summaryEntry?.summary || sessionId
    const content = exportSession(entries, mode, format, title)
    const ext = format === 'md' ? 'md' : 'txt'
    const modeLabel = mode === 'full' ? 'full' : 'compact'
    triggerDownload(content, `session-${modeLabel}.${ext}`)
  }

  // Close export menu on outside click
  useEffect(() => {
    if (!showExportMenu) return
    const handleClick = () => setShowExportMenu(false)
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [showExportMenu])

  const summaryEntry = entries.find((e) => e.type === 'summary')
  const sessionTitle = summaryEntry?.summary || sessionId

  // Calculate paginated entries
  const totalEntries = entries.length
  const totalPages = Math.ceil(totalEntries / pageSize)

  // Keyboard navigation (left/right for sessions, up/down for entry pages)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Cmd/Ctrl+F to focus search
      if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
        event.preventDefault()
        searchInputRef.current?.focus()
        return
      }

      const target = event.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        navigatePrev()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        navigateNext()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setCurrentPage((p) => Math.min(p + 1, totalPages))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setCurrentPage((p) => Math.max(p - 1, 1))
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigatePrev, navigateNext, totalPages])

  const startIndex = (currentPage - 1) * pageSize
  const endIndex = Math.min(startIndex + pageSize, totalEntries)
  const paginatedEntries = entries.slice(startIndex, endIndex)
  const showingFrom = totalEntries > 0 ? startIndex + 1 : 0
  const showingTo = endIndex

  // Extract text content from an entry for search matching
  const getEntryText = useCallback((entry: SessionEntry): string => {
    if (entry.type === 'summary') return entry.summary || ''
    if (!entry.message) return ''
    const content = entry.message.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content.map((block) => {
      if (block.type === 'text') return block.text || ''
      if (block.type === 'thinking') return block.thinking || ''
      if (block.type === 'tool_use') return `${block.name || ''} ${block.input ? JSON.stringify(block.input) : ''}`
      if (block.type === 'tool_result') return typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '')
      return ''
    }).join(' ')
  }, [])

  // Helper to check if an entry has visible content after filtering
  const hasVisibleContent = useCallback((entry: SessionEntry): boolean => {
    if (entry.type === 'summary') {
      if (searchQuery) return getEntryText(entry).toLowerCase().includes(searchQuery.toLowerCase())
      return true
    }
    if (entry.type === 'user' && !showUser) return false
    if (entry.type === 'assistant' && !showAssistant) return false
    if (entry.type !== 'user' && entry.type !== 'assistant') return false
    if (!entry.message) return false

    const content = entry.message.content
    if (typeof content === 'string') {
      if (!content.trim()) return false
      if (searchQuery) return content.toLowerCase().includes(searchQuery.toLowerCase())
      return true
    }
    if (!Array.isArray(content)) return false

    // Check if any block would be visible after filtering
    const hasVisibleBlock = content.some((block) => {
      if (block.type === 'text' && block.text?.trim()) return true
      if (block.type === 'thinking' && showThinking) return true
      if ((block.type === 'tool_use' || block.type === 'tool_result') && showTools) return true
      return false
    })
    if (!hasVisibleBlock) return false

    if (searchQuery) return getEntryText(entry).toLowerCase().includes(searchQuery.toLowerCase())
    return true
  }, [showUser, showAssistant, showTools, showThinking, searchQuery, getEntryText])

  return (
    <div class={styles.page}>
      <div class={styles.header}>
        <div class={styles.headerTop}>
          {navPosition && (
            <div class={styles.navControls}>
              <button
                class={styles.navButton}
                onClick={navigatePrev}
                title="Previous session (Left arrow)"
              >
                <ChevronLeft size={18} />
              </button>
              <span class={styles.navPosition} data-testid="nav-position">
                Session {navPosition.current} of {navPosition.total}
              </span>
              <button
                class={styles.navButton}
                onClick={navigateNext}
                title="Next session (Right arrow)"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          )}
        </div>
        <h1 class={styles.title}>{sessionTitle}</h1>
        <div class={styles.metaRow}>
          <div class={styles.idBadge}>
            <span class={styles.idLabel}>ID</span>
            <span class={styles.idValue} title={sessionId}>{sessionId.slice(0, 8)}…</span>
            <CopyButton text={sessionId} size={12} />
          </div>
          {sessionMeta && (
            <>
              {sessionMeta.duration && (
                <span class={styles.badge}>{sessionMeta.duration}</span>
              )}
              <span class={styles.badge}>{formatBytes(sessionMeta.size)}</span>
              <span class={styles.badge}>{sessionMeta.entry_count} entries</span>
            </>
          )}
          {syncedSessionId && (
            <Link
              href={projectId
                ? `/projects/${projectId}/sessions/${syncedSessionId}`
                : `/sessions/${syncedSessionId}`}
              class={styles.viewTranscriptLink}
              title="View as transcript"
            >
              <FileText size={14} />
              Transcript
            </Link>
          )}
        </div>
      </div>

      {error && <div class={styles.error}>{error}</div>}

        <div class={styles.toolbar}>
          <div class={styles.searchWrapper}>
            <Search size={14} class={styles.searchIcon} />
            <input
              ref={searchInputRef}
              type="text"
              class={styles.searchInput}
              placeholder="Search entries..."
              value={searchQuery}
              onInput={(e) => {
                setSearchQuery((e.target as HTMLInputElement).value)
                setCurrentPage(1)
              }}
            />
            {searchQuery && (
              <button
                class={styles.searchClear}
                onClick={() => { setSearchQuery(''); setCurrentPage(1) }}
                title="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div class={styles.modeToggle}>
            {(['formatted', 'json'] as ViewMode[]).map((mode) => (
              <button
                key={mode}
                class={clsx(styles.toggleButton, viewMode === mode && styles.toggleButtonActive)}
                onClick={() => setViewMode(mode)}
              >
                {mode === 'json' ? 'JSON' : 'Formatted'}
              </button>
            ))}
          </div>
          <div class={styles.sortControl}>
            <label class={styles.sortLabel} htmlFor="session-sort-order">Sort</label>
            <select
              id="session-sort-order"
              class={styles.sortSelect}
              value={sortOrder}
              onChange={(e) => {
                setSortOrder((e.target as HTMLSelectElement).value as SortOrder)
                setCurrentPage(1)
              }}
            >
              <option value="desc">Newest first</option>
              <option value="asc">Oldest first</option>
            </select>
          </div>

          <div class={styles.displayOptions}>
            <label class={styles.displayToggle}>
              <input
                type="checkbox"
                checked={showUser}
                onChange={(e) => setShowUser((e.target as HTMLInputElement).checked)}
              />
              User
            </label>
            <label class={styles.displayToggle}>
              <input
                type="checkbox"
                checked={showAssistant}
                onChange={(e) => setShowAssistant((e.target as HTMLInputElement).checked)}
              />
              Assistant
            </label>
            <label class={styles.displayToggle}>
              <input
                type="checkbox"
                checked={showTools}
                onChange={(e) => setShowTools((e.target as HTMLInputElement).checked)}
              />
              Tools
            </label>
            <label class={styles.displayToggle}>
              <input
                type="checkbox"
                checked={showThinking}
                onChange={(e) => setShowThinking((e.target as HTMLInputElement).checked)}
              />
              Thinking
            </label>
          </div>

          <div class={styles.toolbarActions}>
          <div class={styles.exportDropdown}>
            <button
              class={styles.exportButton}
              onClick={(e) => {
                e.stopPropagation()
                setShowExportMenu((prev) => !prev)
              }}
            >
              <Download size={14} />
              Export
            </button>
            {showExportMenu && (
              <div class={styles.exportMenu} onClick={(e) => e.stopPropagation()}>
                <button class={styles.exportMenuItem} onClick={() => handleExport('full', 'md')}>
                  Full (.md)
                </button>
                <button class={styles.exportMenuItem} onClick={() => handleExport('compact', 'md')}>
                  Compact (.md)
                </button>
                <button class={styles.exportMenuItem} onClick={() => handleExport('full', 'txt')}>
                  Full (.txt)
                </button>
                <button class={styles.exportMenuItem} onClick={() => handleExport('compact', 'txt')}>
                  Compact (.txt)
                </button>
              </div>
            )}
          </div>

          <button
            class={styles.deleteButton}
            onClick={() => setShowDeleteConfirm(true)}
            title="Delete session"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {sessionMeta?.source === 'backup' && !isLoading && (
        <ArchiveBadge class={styles.archiveBadge} />
      )}

      {isLoading ? (
        <div class={styles.loading}>Loading transcript...</div>
      ) : entries.length === 0 ? (
        <div class={styles.empty}>No entries in this session.</div>
      ) : (
        <>
          {totalEntries > pageSize && (
            <div class={styles.entryPagination}>
              <span class={styles.entryPaginationInfo}>
                Showing {showingFrom}–{showingTo} of {totalEntries.toLocaleString()} entries
              </span>
              <div class={styles.entryPaginationControls}>
                <button
                  class={styles.entryPaginationButton}
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage(1)}
                  title="First page"
                >
                  ««
                </button>
                <button
                  class={styles.entryPaginationButton}
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage((p) => p - 1)}
                  title="Previous page"
                >
                  «
                </button>
                <span class={styles.entryPaginationPage}>
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  class={styles.entryPaginationButton}
                  disabled={currentPage === totalPages}
                  onClick={() => setCurrentPage((p) => p + 1)}
                  title="Next page"
                >
                  »
                </button>
                <button
                  class={styles.entryPaginationButton}
                  disabled={currentPage === totalPages}
                  onClick={() => setCurrentPage(totalPages)}
                  title="Last page"
                >
                  »»
                </button>
              </div>
            </div>
          )}
          <div class={styles.transcript}>
            {paginatedEntries.filter(hasVisibleContent).map((entry, index) => {
              const entryKey = entry.uuid || `entry-${startIndex + index}`
              return (
                <TranscriptEntry
                  key={entryKey}
                  entry={entry}
                  entryKey={entryKey}
                  index={startIndex + index}
                  viewMode={viewMode}
                  expandedEntries={expandedEntries}
                  renderedHtml={renderedHtml}
                  onToggle={toggleExpanded}
                  showTools={showTools}
                  showThinking={showThinking}
                  onContextMenu={(e: MouseEvent) => {
                    if (entry.uuid) {
                      e.preventDefault()
                      setContextMenu({ entryUuid: entry.uuid, position: { x: e.clientX, y: e.clientY } })
                    }
                  }}
                />
              )
            })}
          </div>
          {totalEntries > pageSize && (
            <div class={styles.entryPagination}>
              <span class={styles.entryPaginationInfo}>
                Showing {showingFrom}–{showingTo} of {totalEntries.toLocaleString()} entries
              </span>
              <div class={styles.entryPaginationControls}>
                <button
                  class={styles.entryPaginationButton}
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage(1)}
                  title="First page"
                >
                  ««
                </button>
                <button
                  class={styles.entryPaginationButton}
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage((p) => p - 1)}
                  title="Previous page"
                >
                  «
                </button>
                <span class={styles.entryPaginationPage}>
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  class={styles.entryPaginationButton}
                  disabled={currentPage === totalPages}
                  onClick={() => setCurrentPage((p) => p + 1)}
                  title="Next page"
                >
                  »
                </button>
                <button
                  class={styles.entryPaginationButton}
                  disabled={currentPage === totalPages}
                  onClick={() => setCurrentPage(totalPages)}
                  title="Last page"
                >
                  »»
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {showDeleteConfirm && (
        <ConfirmModal
          title="Delete Session"
          message="Delete this session? This cannot be undone."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {contextMenu && (
        <SessionContextMenu
          sessionId={contextMenu.entryUuid}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
          onShowToast={showToast}
        />
      )}
    </div>
  )
}

// --- Entry rendering component ---

interface TranscriptEntryProps {
  entry: SessionEntry
  entryKey: string
  index: number
  viewMode: ViewMode
  expandedEntries: Set<string>
  renderedHtml: Map<string, string>
  onToggle: (id: string) => void
  showTools: boolean
  showThinking: boolean
  onContextMenu?: (e: MouseEvent) => void
}

function TranscriptEntry({
  entry,
  entryKey,
  index: _index,
  viewMode,
  expandedEntries,
  renderedHtml,
  onToggle,
  showTools,
  showThinking,
  onContextMenu,
}: TranscriptEntryProps) {
  // JSON mode: show raw JSON for everything
  if (viewMode === 'json') {
    return (
      <div class={styles.jsonEntry} onContextMenu={onContextMenu}>
        {JSON.stringify(entry, null, 2)}
      </div>
    )
  }

  // Summary entry
  if (entry.type === 'summary') {
    return (
      <div class={styles.summaryEntry} onContextMenu={onContextMenu}>
        {entry.summary || 'Session'}
      </div>
    )
  }

  // User/assistant messages
  if ((entry.type === 'user' || entry.type === 'assistant') && entry.message) {
    const isUser = entry.type === 'user'
    const msg = entry.message
    const entryClass = isUser ? styles.userEntry : styles.assistantEntry

    return (
      <div class={entryClass} onContextMenu={onContextMenu}>
        <div class={styles.entryRole}>
          {isUser ? 'User' : 'Assistant'}
          {entry.timestamp && (
            <span style={{ fontWeight: 'normal', marginLeft: '8px' }}>
              {formatRelativeTime(entry.timestamp)}
            </span>
          )}
        </div>
        <div class={styles.entryContent}>
          {typeof msg.content === 'string' ? (
            viewMode === 'formatted' ? (
              <div
                class={styles.renderedContent}
                dangerouslySetInnerHTML={{ __html: renderedHtml.get(entryKey) || msg.content }}
              />
            ) : (
              msg.content
            )
          ) : Array.isArray(msg.content) ? (
            <ContentBlockList
              blocks={msg.content}
              entryKey={entryKey}
              viewMode={viewMode}
              expandedEntries={expandedEntries}
              renderedHtml={renderedHtml}
              onToggle={onToggle}
              showTools={showTools}
              showThinking={showThinking}
            />
          ) : null}
        </div>
        {viewMode === 'formatted' && msg.usage && (
          <div class={styles.entryUsage}>
            {msg.usage.input_tokens.toLocaleString()} in / {msg.usage.output_tokens.toLocaleString()} out
          </div>
        )}
      </div>
    )
  }

  // Hide all other entry types (system, file-history-snapshot, progress, queue-operation, etc.)
  return null
}

// --- Content block rendering ---

interface ContentBlockListProps {
  blocks: SessionContentBlock[]
  entryKey: string
  viewMode: ViewMode
  expandedEntries: Set<string>
  renderedHtml: Map<string, string>
  onToggle: (id: string) => void
  showTools: boolean
  showThinking: boolean
}

function ContentBlockList({ blocks, entryKey, viewMode, expandedEntries, renderedHtml, onToggle, showTools, showThinking }: ContentBlockListProps) {
  // Filter blocks based on display options
  const filteredBlocks = blocks.filter((block) => {
    if (!showThinking && block.type === 'thinking') return false
    if (!showTools && (block.type === 'tool_use' || block.type === 'tool_result')) return false
    return true
  })

  return (
    <>
      {filteredBlocks.map((block, i) => {
        const blockKey = `${entryKey}-${block.type}-${i}`

        if (block.type === 'text' && block.text) {
          if (viewMode === 'formatted') {
            const htmlKey = `${entryKey}-text-${i}`
            return (
              <div
                key={blockKey}
                class={styles.renderedContent}
                dangerouslySetInnerHTML={{ __html: renderedHtml.get(htmlKey) || block.text }}
              />
            )
          }
          return <div key={blockKey}>{block.text}</div>
        }

        if (block.type === 'thinking' && block.thinking) {
          const isExpanded = expandedEntries.has(blockKey)
          return (
            <div key={blockKey}>
              <button
                class={styles.collapsibleHeader}
                onClick={() => onToggle(blockKey)}
              >
                <ChevronRight
                  size={12}
                  class={clsx(styles.collapsibleChevron, isExpanded && styles.collapsibleChevronOpen)}
                />
                Thinking...
              </button>
              {isExpanded && (
                <div class={styles.collapsibleBody}>
                  {block.thinking}
                </div>
              )}
            </div>
          )
        }

        if (block.type === 'tool_use') {
          const isExpanded = expandedEntries.has(blockKey)
          return (
            <div key={blockKey}>
              <button
                class={styles.collapsibleHeader}
                onClick={() => onToggle(blockKey)}
              >
                <ChevronRight
                  size={12}
                  class={clsx(styles.collapsibleChevron, isExpanded && styles.collapsibleChevronOpen)}
                />
                Tool: {block.name || 'unknown'}
              </button>
              {isExpanded && (
                <div class={styles.collapsibleBody}>
                  {block.input ? JSON.stringify(block.input, null, 2) : '(no input)'}
                </div>
              )}
            </div>
          )
        }

        if (block.type === 'tool_result') {
          const isExpanded = expandedEntries.has(blockKey)
          const resultStr = typeof block.content === 'string'
            ? block.content
            : block.content ? JSON.stringify(block.content, null, 2) : '(no result)'
          return (
            <div key={blockKey}>
              <button
                class={styles.collapsibleHeader}
                onClick={() => onToggle(blockKey)}
              >
                <ChevronRight
                  size={12}
                  class={clsx(styles.collapsibleChevron, isExpanded && styles.collapsibleChevronOpen)}
                />
                Tool Result
              </button>
              {isExpanded && (
                <div class={styles.collapsibleBody}>
                  {resultStr}
                </div>
              )}
            </div>
          )
        }

        return null
      })}
    </>
  )
}
