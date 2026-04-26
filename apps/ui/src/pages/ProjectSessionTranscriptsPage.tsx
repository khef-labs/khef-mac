import { useState, useEffect, useRef } from 'preact/hooks'
import { Link, useLocation } from 'wouter-preact'
import { Clock, Hash, FileText, FolderOpen, Radio, Search, X, Trash2 } from 'lucide-preact'
import clsx from 'clsx'
import { getSyncedSessions, getSessionContext, getActiveSessions, bulkDeleteSessions } from '../lib/api'
import { formatRelativeTime } from '../lib/format'
import { setSessionNavContext } from '../lib/sessionNavContext'
import type { SyncedSession, ActiveSession } from '../types'
import { SessionContextMenu } from '../components/shared/SessionContextMenu'
import { PageHeader } from '../components/layout'

interface SyncedPagination {
  total: number
  limit: number
  offset: number
}
import { cardStyles, ConfirmModal, useToast } from '../components/ui'
import styles from './ProjectSessionTranscriptsPage.module.css'

interface Props {
  projectId: string
}

type SortOption = 'date-desc' | 'date-asc' | 'size-desc' | 'size-asc'

function parseSortOption(option: SortOption): { sort: 'started_at' | 'file_size'; order: 'asc' | 'desc' } {
  switch (option) {
    case 'date-asc': return { sort: 'started_at', order: 'asc' }
    case 'size-desc': return { sort: 'file_size', order: 'desc' }
    case 'size-asc': return { sort: 'file_size', order: 'asc' }
    default: return { sort: 'started_at', order: 'desc' }
  }
}

const PAGE_SIZE = 30

export function ProjectSessionTranscriptsPage({ projectId }: Props) {
  const { showToast } = useToast()
  const [, setLocation] = useLocation()
  const [projectName, setProjectName] = useState<string>('')
  const [projectHandle, setProjectHandle] = useState<string>('')
  const [sessions, setSessions] = useState<SyncedSession[]>([])
  const [pagination, setPagination] = useState<SyncedPagination | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortOption, setSortOption] = useState<SortOption>('date-desc')
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([])
  const activeSessionIds = new Set(activeSessions.map(s => s.session_id))
  const [deleteTarget, setDeleteTarget] = useState<SyncedSession | null>(null)
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; position: { x: number; y: number } } | null>(null)

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await bulkDeleteSessions('claude-code', { sessionIds: [deleteTarget.session_id] })
      setDeleteTarget(null)
      // Reload sessions
      setIsLoading(true)
      const offset = (currentPage - 1) * PAGE_SIZE
      const { sort, order } = parseSortOption(sortOption)
      const data = await getSyncedSessions({
        project: projectHandle || projectId,
        q: debouncedQuery || undefined,
        limit: PAGE_SIZE,
        offset,
        sort,
        order,
      })
      setSessions(data.sessions || [])
      setPagination(data.pagination || null)
      setIsLoading(false)
    } catch (err: any) {
      setError(err.message || 'Failed to delete session')
      setDeleteTarget(null)
      setIsLoading(false)
    }
  }

  const handleContextMenu = (e: MouseEvent, sessionId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ sessionId, position: { x: e.clientX, y: e.clientY } })
  }

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery)
      setCurrentPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Load active sessions for this project
  useEffect(() => {
    let mounted = true
    getActiveSessions({ project_id: projectId })
      .then((data) => {
        if (mounted) setActiveSessions(data.sessions || [])
      })
      .catch(() => {})
    return () => { mounted = false }
  }, [projectId])

  // Load project info
  useEffect(() => {
    getSessionContext(projectId)
      .then((ctx) => {
        setProjectName(ctx?.project?.display_name || ctx?.project?.name || projectId)
        setProjectHandle(ctx?.project?.handle || '')
      })
      .catch(() => {})
  }, [projectId])

  // Load synced sessions for this project
  useEffect(() => {
    let mounted = true
    setIsLoading(true)
    setError(null)

    const offset = (currentPage - 1) * PAGE_SIZE
    const { sort, order } = parseSortOption(sortOption)

    getSyncedSessions({
      project: projectHandle || projectId,
      q: debouncedQuery || undefined,
      limit: PAGE_SIZE,
      offset,
      sort,
      order,
    })
      .then((data) => {
        if (!mounted) return
        setSessions(data.sessions || [])
        setPagination(data.pagination || null)
      })
      .catch((err) => {
        if (!mounted) return
        console.warn('Failed to load sessions:', err)
      })
      .finally(() => {
        if (mounted) setIsLoading(false)
      })

    return () => { mounted = false }
  }, [projectId, projectHandle, currentPage, sortOption, debouncedQuery])

  const totalPages = pagination ? Math.max(1, Math.ceil(pagination.total / PAGE_SIZE)) : 1

  const handleSessionClick = (session: SyncedSession) => {
    const ids = sessions.map((s) => String(s.id))
    setSessionNavContext(ids, String(session.id), `/projects/${projectId}/sessions`, projectId)
    setLocation(`/projects/${projectId}/sessions/${session.id}`)
  }

  return (
    <div class={styles.page}>
      <div class={styles.header}>
        <PageHeader
          title="Sessions"
          breadcrumbs={[{ label: 'Projects', href: '/projects' }, { label: projectName || projectId, href: `/projects/${projectId}` }]}
        />
        {pagination && (
          <p class={styles.subtitle}>
            {pagination.total} synced session{pagination.total !== 1 ? 's' : ''}
          </p>
        )}
      </div>

      {activeSessions.length > 0 && (
        <div class={styles.activeBanner}>
          <div class={styles.activeBannerHeader}>
            <Radio size={14} class={styles.activeIcon} />
            <span>{activeSessions.length} Active Session{activeSessions.length !== 1 ? 's' : ''}</span>
          </div>
          <div class={styles.activeBannerList}>
            {activeSessions.map((session) => {
              const href = session.transcript?.synced_session_id
                ? `/projects/${projectId}/sessions/${session.transcript.synced_session_id}`
                : `/projects/${projectId}/sessions/files`
              return (
                <Link
                  key={session.session_id}
                  href={href}
                  class={styles.activeItem}
                  onContextMenu={(e: MouseEvent) => handleContextMenu(e, session.session_id)}
                >
                  <span class={styles.statusDot} />
                  <span class={styles.activeItemLabel}>
                    {session.nickname || `PID ${session.pid}`}
                    {session.transcript?.message_count ? ` · ${session.transcript.message_count} msgs` : ''}
                  </span>
                </Link>
              )
            })}
          </div>
        </div>
      )}

      <div class={styles.toolbar}>
        <div class={styles.searchWrapper}>
          <Search size={14} class={styles.searchIcon} />
          <input
            ref={searchInputRef}
            type="text"
            class={styles.searchInput}
            placeholder="Search session content..."
            value={searchQuery}
            onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
          />
          {searchQuery && (
            <button
              class={styles.searchClear}
              onClick={() => { setSearchQuery(''); searchInputRef.current?.focus() }}
              title="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <Link href={`/projects/${projectId}/sessions/files`} class={styles.rawFilesLink}>
          <FolderOpen size={14} />
          Raw Files
        </Link>
        <div class={styles.sortControl}>
          <select
            class={styles.sortSelect}
            value={sortOption}
            onChange={(e) => {
              setSortOption((e.target as HTMLSelectElement).value as SortOption)
              setCurrentPage(1)
            }}
          >
            <option value="date-desc">Newest first</option>
            <option value="date-asc">Oldest first</option>
            <option value="size-desc">Largest first</option>
            <option value="size-asc">Smallest first</option>
          </select>
        </div>
      </div>

      {error && <div class={styles.error}>{error}</div>}

      {isLoading ? (
        <div class={styles.loading}>Loading sessions...</div>
      ) : sessions.length === 0 ? (
        <div class={styles.empty}>
          <p>No synced sessions found for this project.</p>
          <p class={styles.emptyHint}>
            Sessions need to be synced to the database before they appear here.
            Check the sync status in Settings.
          </p>
        </div>
      ) : (
        <>
          <div class={styles.sessionList}>
            {sessions.map((session) => (
              <div
                key={session.id}
                class={clsx(cardStyles.card, cardStyles.interactive, styles.sessionCard)}
                data-testid={`session-card--${session.id}`}
                onClick={() => handleSessionClick(session)}
                onContextMenu={(e: MouseEvent) => handleContextMenu(e, session.session_id)}
              >
                <div class={styles.sessionTitle}>
                  {activeSessionIds.has(session.session_id) && (
                    <span class={styles.statusDot} title="Active session" />
                  )}
                  {session.nickname || session.session_id}
                </div>
                {session.summary && (
                  <div class={styles.sessionSummary}>{session.summary}</div>
                )}
                {session.search_excerpt && (
                  <div class={styles.searchExcerpt}>{session.search_excerpt}</div>
                )}
                <div class={styles.sessionMeta}>
                  {session.started_at && (
                    <span class={styles.badge}>
                      <Clock size={12} />
                      {formatRelativeTime(session.started_at)}
                    </span>
                  )}
                  <span class={styles.badge}>
                    <Hash size={12} />
                    {session.chunk_count} chunks
                  </span>
                  {session.message_count && (
                    <span class={styles.badge}>
                      <FileText size={12} />
                      {session.message_count} messages
                    </span>
                  )}
                </div>
                <div class={styles.sessionActions}>
                  <button
                    class={styles.deleteButton}
                    title="Delete session"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeleteTarget(session)
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {pagination && pagination.total > PAGE_SIZE && (
            <div class={styles.pagination}>
              <div class={styles.paginationControls}>
                <button
                  class={styles.paginationButton}
                  onClick={() => setCurrentPage((p) => p - 1)}
                  disabled={currentPage <= 1}
                >
                  Previous
                </button>
                <span class={styles.paginationInfo}>
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  class={styles.paginationButton}
                  onClick={() => setCurrentPage((p) => p + 1)}
                  disabled={currentPage >= totalPages}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete Session"
          message="Delete this session? This cannot be undone."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {contextMenu && (
        <SessionContextMenu
          sessionId={contextMenu.sessionId}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
          onShowToast={showToast}
        />
      )}
    </div>
  )
}
