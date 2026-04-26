import { useState, useEffect, useCallback, useMemo, useRef } from 'preact/hooks'
import { Link, useLocation } from 'wouter-preact'
import { Trash2, Search, X } from 'lucide-preact'
import clsx from 'clsx'
import { getSessionProjects, getProjectSessions, getSessionIds, deleteSession } from '../lib/api'
import { getSessionContext } from '../lib/api'
import { formatBytes, formatRelativeTime } from '../lib/format'
import { setNavContext } from '../lib/navContext'
import type { SessionFile, Pagination } from '../types'
import { cardStyles, ConfirmModal, useToast } from '../components/ui'
import { SessionFiltersPanel, type SessionFilterValues } from '../components/session'
import { SessionContextMenu } from '../components/shared/SessionContextMenu'
import { PageHeader } from '../components/layout'
import { useLiveUpdates } from '../hooks/useLiveUpdates'
import styles from './ProjectSessionsPage.module.css'

interface Props {
  projectId?: string
  dirName?: string
  handle?: string
}

const PAGE_SIZE = 30

export function ProjectSessionsPage({ projectId, dirName: dirNameProp, handle = 'claude-code' }: Props) {
  const { showToast } = useToast()
  const [, setLocation] = useLocation()

  const [projectName, setProjectName] = useState<string>('')
  const [dirName, setDirName] = useState<string | null>(dirNameProp || null)
  const [totalSize, setTotalSize] = useState<number | null>(null)
  const [sessions, setSessions] = useState<SessionFile[]>([])
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [filters, setFilters] = useState<SessionFilterValues>({
    sort: 'date',
    order: 'desc',
    date: '',
    date_from: '',
    date_to: '',
    date_range_mode: false,
    has_companion: '',
  })
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SessionFile | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; position: { x: number; y: number } } | null>(null)

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

  // Resolve the project ID to a session directory name (skip if dirName provided directly)
  useEffect(() => {
    if (dirNameProp) {
      setProjectName(decodeURIComponent(dirNameProp))
      // Still fetch session projects to get total_size for this dir
      getSessionProjects('claude-code').then((data) => {
        const match = data.projects?.find((p) => p.dir_name === dirNameProp)
        if (match) setTotalSize(match.total_size)
      }).catch(() => {})
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

      const name = ctx?.project?.display_name || ctx?.project?.name || projectId
      setProjectName(name)

      if (sessionData?.projects) {
        const match = sessionData.projects.find(
          (p) => p.matched_project?.id === projectId || p.matched_project?.handle === projectId
        )
        if (match) {
          setDirName(match.dir_name)
          setTotalSize(match.total_size)
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

  // Load sessions once dir_name is resolved
  const loadSessions = useCallback(async () => {
    if (!dirName) return

    setIsLoading(true)
    setError(null)
    try {
      const data = await getProjectSessions('claude-code', dirName, {
        sort: filters.sort,
        order: filters.order,
        limit: 500,
        offset: 0,
        q: debouncedQuery || undefined,
      })
      setSessions(data.sessions || [])
      setPagination(data.pagination || null)
    } catch (err) {
      console.warn('Failed to load sessions:', err)
    } finally {
      setIsLoading(false)
    }
  }, [dirName, filters.sort, filters.order, debouncedQuery])

  // Live updates: refetch the session list when sessions start or end so
  // new entries appear and status changes show without a manual refresh.
  useLiveUpdates(
    ['sessions:active'],
    useCallback((_room, delta) => {
      if (delta.type !== 'session.created' && delta.type !== 'session.ended') return
      loadSessions().catch(() => {
        // Silent — next delta will retry
      })
    }, [loadSessions])
  )

  // Apply client-side filters (date, has_companion)
  const filteredSessions = useMemo(() => {
    let result = sessions

    // Filter by has_companion
    if (filters.has_companion === 'true') {
      result = result.filter(s => s.has_companion)
    } else if (filters.has_companion === 'false') {
      result = result.filter(s => !s.has_companion)
    }

    // Filter by date
    if (filters.date_range_mode) {
      if (filters.date_from) {
        const from = new Date(filters.date_from)
        from.setHours(0, 0, 0, 0)
        result = result.filter(s => new Date(s.last_modified) >= from)
      }
      if (filters.date_to) {
        const to = new Date(filters.date_to)
        to.setHours(23, 59, 59, 999)
        result = result.filter(s => new Date(s.last_modified) <= to)
      }
    } else if (filters.date) {
      const targetDate = new Date(filters.date)
      result = result.filter(s => {
        const sessionDate = new Date(s.last_modified)
        return sessionDate.toDateString() === targetDate.toDateString()
      })
    }

    return result
  }, [sessions, filters.has_companion, filters.date, filters.date_from, filters.date_to, filters.date_range_mode])

  // Paginate filtered results
  const paginatedSessions = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE
    return filteredSessions.slice(start, start + PAGE_SIZE)
  }, [filteredSessions, currentPage])

  const totalPages = Math.max(1, Math.ceil(filteredSessions.length / PAGE_SIZE))

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  const handleDelete = async () => {
    if (!deleteTarget || !dirName) return
    try {
      await deleteSession('claude-code', dirName, deleteTarget.id)
      setDeleteTarget(null)
      loadSessions()
    } catch (err: any) {
      setError(err.message || 'Failed to delete session')
      setDeleteTarget(null)
    }
  }

  const handleFiltersChange = (newFilters: SessionFilterValues) => {
    setFilters(newFilters)
    setCurrentPage(1)
  }

  return (
    <div class={styles.page}>
      <div class={styles.header}>
        <PageHeader
          title="Session Files"
          subtitle={pagination ? `${pagination.total_count} session${pagination.total_count !== 1 ? 's' : ''}${totalSize != null ? ` · ${formatBytes(totalSize)}` : ''}` : undefined}
          breadcrumbs={projectId
            ? [{ label: 'Projects', href: '/projects' }, { label: projectName || projectId, href: `/projects/${projectId}` }]
            : [{ label: 'Assistants', href: '/assistants' }, { label: handle || '', href: `/assistants/${handle}` }]
          }
        />
      </div>

      {error && <div class={styles.error}>{error}</div>}

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

      <SessionFiltersPanel filters={filters} onChange={handleFiltersChange} />

      {isLoading ? (
        <div class={styles.loading}>Loading sessions...</div>
      ) : filteredSessions.length === 0 ? (
        <div class={styles.empty}>
          {debouncedQuery ? 'No sessions match the search.' : 'No sessions found.'}
        </div>
      ) : (
        <>
          <div class={styles.sessionList}>
            {paginatedSessions.map((session) => {
              const sessionHref = projectId
                ? `/projects/${projectId}/sessions/files/${encodeURIComponent(session.id)}`
                : `/assistants/${handle}/sessions/${encodeURIComponent(dirName!)}/${encodeURIComponent(session.id)}`
              const sourceUrl = projectId
                ? `/projects/${projectId}/sessions/files`
                : `/assistants/${handle}/sessions/${encodeURIComponent(dirName!)}`
              return (
              <Link
                key={session.id}
                href={sessionHref}
                class={clsx(cardStyles.card, cardStyles.interactive, styles.sessionCard)}
                data-testid={`session-card--${session.id}`}
                onContextMenu={(e: MouseEvent) => handleContextMenu(e, session.id)}
                onClick={async (e) => {
                  e.preventDefault()
                  // Fetch all session IDs in current sort order for complete navigation
                  try {
                    const data = await getSessionIds(handle, dirName!, { sort: filters.sort, order: filters.order })
                    if (data.ids?.length) {
                      // Filter server IDs to only include those that pass client-side filters
                      // This preserves the server's sort order while respecting client filters
                      const filteredIdSet = new Set(filteredSessions.map(s => s.id))
                      const navIds = data.ids.filter(id => filteredIdSet.has(id))
                      setNavContext(navIds, session.id, sourceUrl)
                    } else {
                      // Fallback to filtered sessions
                      setNavContext(filteredSessions.map((s) => s.id), session.id, sourceUrl)
                    }
                  } catch {
                    // Fallback to filtered sessions on error
                    setNavContext(filteredSessions.map((s) => s.id), session.id, sourceUrl)
                  }
                  setLocation(sessionHref)
                }}
              >
                <div class={styles.sessionTitle}>
                  {session.summary || session.id}
                </div>
                {session.search_excerpt && (
                  <div class={styles.searchExcerpt}>{session.search_excerpt}</div>
                )}
                <div class={styles.sessionMeta}>
                  <span class={styles.badge}>{formatRelativeTime(session.last_modified)}</span>
                  <span class={styles.badge}>{formatBytes(session.size)}</span>
                  {session.has_companion && (
                    <span class={styles.companionBadge} title="Has companion file with detailed tool results and thinking blocks">companion</span>
                  )}
                </div>
                <div class={styles.sessionActions}>
                  <button
                    class={styles.deleteButton}
                    title="Delete session"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setDeleteTarget(session)
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </Link>
              )
            })}
          </div>

          {filteredSessions.length > PAGE_SIZE && (
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
                  {filteredSessions.length !== sessions.length && (
                    <> ({filteredSessions.length} of {sessions.length})</>
                  )}
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
          message={`Delete this session? This cannot be undone.`}
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
