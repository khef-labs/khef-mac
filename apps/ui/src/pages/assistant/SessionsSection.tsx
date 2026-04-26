import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
import { Link, useLocation } from 'wouter-preact'
import { RefreshCw, Search, X, ArrowUp, ArrowDown, Trash2 } from 'lucide-preact'
import clsx from 'clsx'
import { getSessionProjects, getSessionSyncStatus, getSyncedSessions, getActiveSessions, scanActiveSessions, bulkDeleteSessions, createKdagJob, runKdagJob } from '../../lib/api'
import { formatBytes, formatRelativeTime } from '../../lib/format'
import { setSessionNavContext } from '../../lib/sessionNavContext'
import type { SessionProject, SessionSyncStatus, ActiveSession, SyncedSession } from '../../types'
import { cardStyles, ConfirmModal, useToast } from '../../components/ui'
import { SessionContextMenu } from '../../components/shared/SessionContextMenu'
import { useDebounce } from '../../hooks'
import styles from './SessionsSection.module.css'

interface Props {
  handle: string
  initialProjectFilter?: string
}

function cleanProjectDir(dir: string): string {
  const cleaned = dir.replace(/^-Users-[^-]+-?/, '').replace(/-/g, '/')
  return (cleaned || dir).toLowerCase()
}

function formatDurationDays(firstSeen: string | null): string {
  if (!firstSeen) return ''
  const ms = Date.now() - new Date(firstSeen).getTime()
  const days = Math.floor(ms / 86400000)
  if (days === 0) return 'today'
  return `${days}d`
}

/** Map model ID to max context window size in tokens */
function getContextWindowSize(model: string | null): number | null {
  if (!model) return null
  if (model.startsWith('claude-opus-4')) return 1_000_000
  if (model.startsWith('claude-sonnet-4')) return 200_000
  if (model.startsWith('claude-haiku-4')) return 200_000
  if (model.startsWith('claude-3')) return 200_000
  if (model.includes('gpt-4o') || model.includes('gpt-4')) return 128_000
  if (model.includes('o3') || model.includes('o4')) return 200_000
  return null
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000
    return m === Math.floor(m) ? `${m}M` : `${m.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

const GROUP_PAGE_SIZE = 10

type SortField = 'name' | 'updated'
type SortDir = 'asc' | 'desc'

interface ProjectGroup {
  name: string
  projectId: string | null
  sessions: SyncedSession[]
  newestAt: number // timestamp for sorting
}

function groupByProject(sessions: SyncedSession[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>()
  for (const s of sessions) {
    const key = s.project?.handle || s.project?.name || 'unknown'
    let group = map.get(key)
    if (!group) {
      const displayName = s.project?.display_name || s.project?.name || key
      group = { name: displayName, projectId: s.project?.id || null, sessions: [], newestAt: 0 }
      map.set(key, group)
    }
    group.sessions.push(s)
    const ts = s.started_at ? new Date(s.started_at).getTime() : 0
    if (ts > group.newestAt) group.newestAt = ts
  }
  return [...map.values()]
}

function sortGroups(
  groups: ProjectGroup[],
  field: SortField,
  dir: SortDir,
  activeIds: Set<string>
): ProjectGroup[] {
  return [...groups].sort((a, b) => {
    // Groups containing any active session float to top
    const aHasActive = a.sessions.some(s => activeIds.has(s.session_id))
    const bHasActive = b.sessions.some(s => activeIds.has(s.session_id))
    if (aHasActive !== bHasActive) return aHasActive ? -1 : 1

    const cmp = field === 'name'
      ? a.name.localeCompare(b.name)
      : a.newestAt - b.newestAt
    return dir === 'desc' ? -cmp : cmp
  })
}

function sortSessions(
  sessions: SyncedSession[],
  field: SortField,
  dir: SortDir,
  activeIds: Set<string>
): SyncedSession[] {
  return [...sessions].sort((a, b) => {
    // Active sessions always come first regardless of sort
    const aActive = activeIds.has(a.session_id)
    const bActive = activeIds.has(b.session_id)
    if (aActive !== bActive) return aActive ? -1 : 1

    let cmp: number
    if (field === 'name') {
      const aN = a.nickname || '\uffff'
      const bN = b.nickname || '\uffff'
      cmp = aN.localeCompare(bN)
    } else {
      const aT = a.started_at ? new Date(a.started_at).getTime() : 0
      const bT = b.started_at ? new Date(b.started_at).getTime() : 0
      cmp = aT - bT
    }
    return dir === 'desc' ? -cmp : cmp
  })
}

export function SessionsSection({ handle, initialProjectFilter = '' }: Props) {
  const { showToast } = useToast()
  const [, setLocation] = useLocation()
  const [isLoading, setIsLoading] = useState(true)

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const debouncedQuery = useDebounce(searchQuery, 300)
  const [searchMode, setSearchMode] = useState<'summary' | 'content'>('summary')

  // Filters
  const [projectFilter, setProjectFilter] = useState<string>(initialProjectFilter)
  const [nicknameFilter, setNicknameFilter] = useState<string>('')

  // Active sessions
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; nickname?: string; position: { x: number; y: number } } | null>(null)

  // Recent sessions
  const [recentSessions, setRecentSessions] = useState<SyncedSession[]>([])
  const [recentTotal, setRecentTotal] = useState(0)
  const [recentLoading, setRecentLoading] = useState(true)

  // Sort state
  const [projectSort, setProjectSort] = useState<{ field: SortField; dir: SortDir }>({ field: 'updated', dir: 'desc' })
  const [sessionSort, setSessionSort] = useState<{ field: SortField; dir: SortDir }>({ field: 'updated', dir: 'desc' })

  // Per-project pagination (keyed by project handle/name)
  const [groupPages, setGroupPages] = useState<Record<string, number>>({})

  // Load active sessions
  useEffect(() => {
    let mounted = true
    setIsLoading(true)
    getActiveSessions({ status: 'active', assistant: handle })
      .then((activeData) => {
        if (!mounted) return
        setActiveSessions(activeData.sessions || [])
      })
      .catch(() => {})
      .finally(() => { if (mounted) setIsLoading(false) })
    return () => { mounted = false }
  }, [handle])

  // Load recent sessions (project filter + content search are server-side)
  useEffect(() => {
    let mounted = true
    setRecentLoading(true)
    const params: Parameters<typeof getSyncedSessions>[0] = {
      assistant: handle,
      limit: 100,
      sort: 'started_at',
      order: 'desc',
    }
    if (projectFilter) {
      params.project = projectFilter
    }
    if (searchMode === 'content' && debouncedQuery.length >= 2) {
      params.q = debouncedQuery
    }
    getSyncedSessions(params)
      .then((data) => {
        if (!mounted) return
        setRecentSessions(data.sessions || [])
        setRecentTotal(data.pagination?.total || 0)
      })
      .catch(() => {})
      .finally(() => { if (mounted) setRecentLoading(false) })
    return () => { mounted = false }
  }, [handle, projectFilter, searchMode === 'content' ? debouncedQuery : ''])

  // Filter recent sessions client-side (summary mode filters locally, content mode filters via API)
  const filteredRecent = useMemo(() => {
    let result = recentSessions
    if (nicknameFilter) {
      const nf = nicknameFilter.toLowerCase()
      result = result.filter(s => (s.nickname || '').toLowerCase().includes(nf))
    }
    if (searchMode === 'summary' && debouncedQuery) {
      const q = debouncedQuery.toLowerCase()
      result = result.filter(s => {
        const nick = (s.nickname || '').toLowerCase()
        const proj = (s.project?.handle || s.project?.name || '').toLowerCase()
        const sid = s.session_id.toLowerCase()
        const summary = (s.summary || '').toLowerCase()
        return nick.includes(q) || proj.includes(q) || sid.includes(q) || summary.includes(q)
      })
    }
    return result
  }, [recentSessions, debouncedQuery, nicknameFilter, searchMode])

  const activeSessionIds = useMemo(
    () => new Set(activeSessions.map(s => s.session_id)),
    [activeSessions]
  )

  const allProjectNames = useMemo(() => {
    const names = new Set<string>()
    for (const s of recentSessions) {
      const name = s.project?.handle || s.project?.name
      if (name) names.add(name)
    }
    return [...names].sort()
  }, [recentSessions])

  // Group and sort recent sessions
  const sortedGroups = useMemo(() => {
    const groups = groupByProject(filteredRecent)
    const sorted = sortGroups(groups, projectSort.field, projectSort.dir, activeSessionIds)
    return sorted.map(g => ({
      ...g,
      sessions: sortSessions(g.sessions, sessionSort.field, sessionSort.dir, activeSessionIds),
    }))
  }, [filteredRecent, projectSort, sessionSort, activeSessionIds])

  // All visible session IDs (flattened from sorted groups) for nav context
  const visibleSessionIds = useMemo(() => {
    return sortedGroups.flatMap(g => g.sessions.map(s => String(s.id)))
  }, [sortedGroups])

  // Filter active sessions by search query
  const filteredActive = useMemo(() => {
    if (!debouncedQuery) return activeSessions
    const q = debouncedQuery.toLowerCase()
    return activeSessions.filter(s => {
      const nick = (s.nickname || '').toLowerCase()
      const proj = (s.project?.handle || s.project?.name || '').toLowerCase()
      const sid = s.session_id.toLowerCase()
      return nick.includes(q) || proj.includes(q) || sid.includes(q)
    })
  }, [activeSessions, debouncedQuery])

  const handleScan = useCallback(() => {
    setIsScanning(true)
    scanActiveSessions()
      .then((data) => setActiveSessions(data.sessions || []))
      .catch(() => {})
      .finally(() => setIsScanning(false))
  }, [])

  const handleContextMenu = useCallback((e: MouseEvent, sessionId: string, nickname?: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ sessionId, nickname, position: { x: e.clientX, y: e.clientY } })
  }, [])

  const [deleteTarget, setDeleteTarget] = useState<SyncedSession | null>(null)

  const handleDeleteSession = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await bulkDeleteSessions('claude-code', { sessionIds: [deleteTarget.session_id] })
      setDeleteTarget(null)
      // Remove from local state
      setRecentSessions(prev => prev.filter(s => s.id !== deleteTarget.id))
      setRecentTotal(prev => prev - 1)
      showToast('Session deleted')
    } catch {
      showToast('Failed to delete session')
      setDeleteTarget(null)
    }
  }, [deleteTarget, showToast])

  const handleDescribe = useCallback(async (sessionId: string) => {
    try {
      const { job } = await createKdagJob({
        definition_key: 'describe-session',
        inputs: { session_id: sessionId },
      })
      await runKdagJob(job.id)
      showToast('Describe job started')
    } catch (err: any) {
      showToast(err?.message || 'Failed to start describe job')
    }
  }, [showToast])

  const toggleProjectSort = useCallback((field: SortField) => {
    setProjectSort(prev =>
      prev.field === field ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: field === 'name' ? 'asc' : 'desc' }
    )
  }, [])

  const toggleSessionSort = useCallback((field: SortField) => {
    setSessionSort(prev =>
      prev.field === field ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: field === 'name' ? 'asc' : 'desc' }
    )
  }, [])

  // Left/right arrow keys for per-group pagination on hovered project
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (!hoveredGroup) return
      const currentPage = groupPages[hoveredGroup] || 0
      const group = sortedGroups.find(g => (g.projectId || g.name) === hoveredGroup)
      if (!group) return
      const totalPages = Math.ceil(group.sessions.length / GROUP_PAGE_SIZE)

      if (e.key === 'ArrowLeft' && currentPage > 0) {
        e.preventDefault()
        setGroupPages(prev => ({ ...prev, [hoveredGroup]: currentPage - 1 }))
      } else if (e.key === 'ArrowRight' && currentPage < totalPages - 1) {
        e.preventDefault()
        setGroupPages(prev => ({ ...prev, [hoveredGroup]: currentPage + 1 }))
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hoveredGroup, groupPages, sortedGroups])

  if (isLoading) {
    return <div class={styles.loading}>Loading sessions...</div>
  }

  const hasAnyData =
    recentLoading ||
    recentTotal > 0 ||
    activeSessions.length > 0 ||
    !!projectFilter ||
    !!nicknameFilter ||
    !!searchQuery

  if (!hasAnyData) {
    return (
      <div class={styles.root}>
        <div class={styles.empty}>No sessions detected.</div>
      </div>
    )
  }

  return (
    <div class={styles.root}>
      {/* Search bar */}
      <div class={styles.searchContainer}>
        <div class={styles.searchInputWrapper}>
          <Search size={16} class={styles.searchIcon} />
          <input
            type="text"
            class={styles.searchInput}
            placeholder={searchMode === 'content' ? 'Search session content...' : 'Search summaries, nicknames, projects...'}
            value={searchQuery}
            onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
          />
          {searchQuery && (
            <button class={styles.searchClear} onClick={() => setSearchQuery('')}>
              <X size={14} />
            </button>
          )}
        </div>
        <div class={styles.searchModeToggle}>
          <button
            class={clsx(styles.searchModeBtn, searchMode === 'summary' && styles.searchModeBtnActive)}
            onClick={() => setSearchMode('summary')}
          >
            Summary
          </button>
          <button
            class={clsx(styles.searchModeBtn, searchMode === 'content' && styles.searchModeBtnActive)}
            onClick={() => setSearchMode('content')}
          >
            Content
          </button>
        </div>
      </div>

      {/* Active sessions banner */}
      {filteredActive.length > 0 && (() => {
        const grouped = new Map<string, ActiveSession[]>()
        for (const s of filteredActive) {
          const key = s.project?.handle || s.project?.name || (s.project_dir ? cleanProjectDir(s.project_dir) : 'unknown')
          const list = grouped.get(key) || []
          list.push(s)
          grouped.set(key, list)
        }
        return (
          <div class={styles.activeBanner}>
            <div class={styles.activeHeader}>
              <div class={styles.activeLabel}>
                <span class={styles.activeDot} />
                {activeSessions.length} Active
              </div>
              <button
                class={styles.scanButton}
                onClick={handleScan}
                disabled={isScanning}
                title="Rescan for active sessions"
              >
                <RefreshCw size={12} class={isScanning ? styles.spinning : undefined} />
              </button>
            </div>
            {[...grouped.entries()].map(([projectName, sessions]) => (
              <div key={projectName} class={styles.activeGroup}>
                <span class={styles.groupName}>{projectName}</span>
                <div class={styles.groupChips}>
                  {sessions.map((session) => {
                    const fromParam = `?from=${encodeURIComponent(`/assistants/${handle}/sessions`)}`
                    const href = session.transcript?.synced_session_id
                      ? session.project
                        ? `/projects/${session.project.id}/sessions/${session.transcript.synced_session_id}${fromParam}`
                        : `/sessions/${session.transcript.synced_session_id}${fromParam}`
                      : null
                    const chipLabel = session.nickname || session.session_id.slice(0, 8)
                    return (
                      <Link
                        key={session.session_id}
                        href={href || `/assistants/${handle}/sessions`}
                        class={styles.activeChip}
                        onContextMenu={(e: MouseEvent) => handleContextMenu(e, session.session_id, session.nickname || undefined)}
                      >
                        <span class={styles.chipDot} />
                        <span class={styles.chipMeta}>{chipLabel}</span>
                        <span class={styles.chipMeta}>{formatDurationDays(session.first_seen_at)}</span>
                        {session.transcript?.context_window_tokens != null && session.transcript.context_window_tokens > 0 && (() => {
                          const ctx = session.transcript!.context_window_tokens!
                          const max = getContextWindowSize(session.transcript!.model)
                          const pct = max ? Math.round((ctx / max) * 100) : null
                          return (
                            <span class={styles.chipContext} title={`Context: ${formatTokenCount(ctx)}${max ? ` / ${formatTokenCount(max)}` : ''} tokens`}>
                              {max && (
                                <span class={styles.chipContextBar}>
                                  <span class={styles.chipContextFill} style={{ width: `${Math.min(pct!, 100)}%` }} />
                                </span>
                              )}
                              <span>{formatTokenCount(ctx)}{max ? `/${formatTokenCount(max)}` : ''}</span>
                            </span>
                          )
                        })()}
                      </Link>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )
      })()}

      {filteredActive.length === 0 && !debouncedQuery && (
        <div class={styles.empty}>
          No active sessions detected.
          <button class={styles.scanButton} onClick={handleScan} disabled={isScanning} style={{ marginLeft: '8px' }}>
            <RefreshCw size={12} class={isScanning ? styles.spinning : undefined} />
          </button>
        </div>
      )}

      {/* Recent sessions — compact row layout */}
      <div class={styles.recentSection}>
        <div class={styles.recentToolbar}>
          <div class={styles.sortRow}>
            <span class={styles.sortLabel}>Project</span>
            <select
              class={styles.projectSelect}
              value={projectFilter}
              onChange={(e) => setProjectFilter((e.target as HTMLSelectElement).value)}
            >
              <option value="">All projects</option>
              {allProjectNames.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
          <div class={styles.sortRow}>
            <span class={styles.sortLabel}>Name</span>
            <input
              type="text"
              class={styles.nicknameInput}
              placeholder="Filter by name..."
              value={nicknameFilter}
              onInput={(e) => setNicknameFilter((e.target as HTMLInputElement).value)}
            />
          </div>
          {!projectFilter && (
            <div class={styles.sortRow}>
              <span class={styles.sortLabel}>Projects</span>
              <div class={styles.sortGroup}>
                <button
                  class={clsx(styles.sortBtn, projectSort.field === 'name' && styles.sortBtnActive)}
                  onClick={() => toggleProjectSort('name')}
                >
                  Name {projectSort.field === 'name' && (projectSort.dir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                </button>
                <button
                  class={clsx(styles.sortBtn, projectSort.field === 'updated' && styles.sortBtnActive)}
                  onClick={() => toggleProjectSort('updated')}
                >
                  Updated {projectSort.field === 'updated' && (projectSort.dir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                </button>
              </div>
            </div>
          )}
          <div class={styles.sortRow}>
            <span class={styles.sortLabel}>Sessions</span>
            <div class={styles.sortGroup}>
              <button
                class={clsx(styles.sortBtn, sessionSort.field === 'name' && styles.sortBtnActive)}
                onClick={() => toggleSessionSort('name')}
              >
                Name {sessionSort.field === 'name' && (sessionSort.dir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
              </button>
              <button
                class={clsx(styles.sortBtn, sessionSort.field === 'updated' && styles.sortBtnActive)}
                onClick={() => toggleSessionSort('updated')}
              >
                Updated {sessionSort.field === 'updated' && (sessionSort.dir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
              </button>
            </div>
          </div>
          <span class={styles.resultCount}>{recentTotal} sessions</span>
          {(projectFilter || nicknameFilter || searchQuery) && (
            <button
              class={styles.clearFiltersBtn}
              onClick={() => { setProjectFilter(''); setNicknameFilter(''); setSearchQuery('') }}
            >
              <X size={12} /> Clear filters
            </button>
          )}
        </div>

        {recentLoading && recentSessions.length === 0 && (
          <div class={styles.loading}>Summoning sessions...</div>
        )}

        {!recentLoading && sortedGroups.length === 0 && (
          <div class={styles.empty}>No sessions found.</div>
        )}

        {!recentLoading && sortedGroups.map((group) => {
          const groupKey = group.projectId || group.name
          const groupPage = groupPages[groupKey] || 0
          const totalInGroup = group.sessions.length
          const pageStart = groupPage * GROUP_PAGE_SIZE
          const pageEnd = Math.min(pageStart + GROUP_PAGE_SIZE, totalInGroup)
          const pagedSessions = group.sessions.slice(pageStart, pageEnd)
          const totalGroupPages = Math.ceil(totalInGroup / GROUP_PAGE_SIZE)
          const hasGroupPrev = groupPage > 0
          const hasGroupNext = groupPage < totalGroupPages - 1

          return (
          <div
            key={group.name}
            class={styles.recentGroup}
            onMouseEnter={() => setHoveredGroup(groupKey)}
            onMouseLeave={() => setHoveredGroup(prev => prev === groupKey ? null : prev)}
          >
            <div class={styles.recentGroupHeader}>
              <span class={styles.recentGroupName}>{group.name}</span>
              <div class={styles.recentGroupControls}>
                {totalGroupPages > 1 && (
                  <>
                    <button
                      class={styles.groupPageBtn}
                      disabled={!hasGroupPrev}
                      onClick={() => setGroupPages(prev => ({ ...prev, [groupKey]: groupPage - 1 }))}
                    >
                      &larr;
                    </button>
                    <span class={styles.groupPageInfo}>{pageStart + 1}-{pageEnd} of {totalInGroup}</span>
                    <button
                      class={styles.groupPageBtn}
                      disabled={!hasGroupNext}
                      onClick={() => setGroupPages(prev => ({ ...prev, [groupKey]: groupPage + 1 }))}
                    >
                      &rarr;
                    </button>
                  </>
                )}
                {totalGroupPages <= 1 && (
                  <span class={styles.recentGroupCount}>{totalInGroup} sessions</span>
                )}
              </div>
            </div>
            <div class={styles.recentList}>
              {pagedSessions.map((session) => {
                const handleClick = (e: MouseEvent) => {
                  e.preventDefault()
                  setSessionNavContext(visibleSessionIds, String(session.id), `/assistants/${handle}/sessions`, session.project?.id || '')
                  setLocation(`/sessions/${session.id}`)
                }
                const isActive = activeSessionIds.has(session.session_id)
                return (
                  <a
                    key={session.id}
                    href={`/sessions/${session.id}`}
                    class={clsx(styles.recentRow, isActive && styles.recentRowActive)}
                    data-testid={`session-card--${session.id}`}
                    onClick={handleClick}
                    onContextMenu={(e: MouseEvent) => handleContextMenu(e, session.session_id, session.nickname || undefined)}
                  >
                    <span class={clsx(styles.recentNick, !session.nickname && styles.recentNickAnon)}>
                      {isActive && <span class={styles.recentActiveDot} title="Active session" />}
                      {session.nickname || session.session_id.slice(0, 8)}
                    </span>
                    <span class={clsx(styles.recentSummary, !session.summary && styles.recentSummaryEmpty)}>
                      {session.summary || 'No summary yet'}
                    </span>
                    <span class={styles.recentMsgs}>
                      {session.message_count ? `${session.message_count} msgs` : ''}
                    </span>
                    <span class={styles.recentTime}>
                      {session.started_at ? formatRelativeTime(session.started_at) : ''}
                    </span>
                    <button
                      class={styles.recentDeleteBtn}
                      title="Delete session"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setDeleteTarget(session)
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </a>
                )
              })}
            </div>
          </div>
          )
        })}

      </div>

      {deleteTarget && (
        <ConfirmModal
          title="Delete Session"
          message="Delete this session? This cannot be undone."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDeleteSession}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {contextMenu && (
        <SessionContextMenu
          sessionId={contextMenu.sessionId}
          nickname={contextMenu.nickname}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
          onShowToast={showToast}
          onDescribe={handleDescribe}
        />
      )}
    </div>
  )
}

export function ReposSection({ handle }: Props) {
  const [projects, setProjects] = useState<SessionProject[]>([])
  const [totalSessions, setTotalSessions] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [repoFilter, setRepoFilter] = useState('')
  const [syncStatus, setSyncStatus] = useState<SessionSyncStatus | null>(null)

  useEffect(() => {
    let mounted = true
    setIsLoading(true)

    Promise.all([
      getSessionProjects(handle),
      getSessionSyncStatus(handle),
    ])
      .then(([projectsData, syncData]) => {
        if (!mounted) return
        setProjects(projectsData.projects || [])
        setTotalSessions(projectsData.total_sessions || 0)
        setSyncStatus(syncData)
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setIsLoading(false)
      })

    return () => { mounted = false }
  }, [handle])

  if (isLoading) {
    return <div class={styles.loading}>Loading repos...</div>
  }

  return (
    <div class={styles.root}>
      <div class={styles.toolbar}>
        <input
          type="text"
          class={styles.filterInput}
          placeholder="Filter repos..."
          value={repoFilter}
          onInput={(e) => setRepoFilter((e.target as HTMLInputElement).value)}
        />
      </div>

      {/* Project list */}
      {(() => {
        const rq = repoFilter.toLowerCase().trim()
        const filtered = rq
          ? projects.filter((p) => {
              const name = (p.matched_project?.name || p.matched_project?.handle || p.decoded_path || '').toLowerCase()
              return name.includes(rq)
            })
          : projects
        return filtered.length === 0 ? (
          <div class={styles.empty}>{rq ? 'No matching repos.' : 'No session transcripts found.'}</div>
        ) : (
          <div class={styles.projectList}>
            {filtered.map((project) => {
              const href = project.matched_project
                ? `/projects/${project.matched_project.id}/sessions`
                : `/assistants/${handle}/sessions/${encodeURIComponent(project.dir_name)}`
              return (
                <Link
                  key={project.dir_name}
                  href={href}
                  class={clsx(cardStyles.card, cardStyles.interactive, styles.projectCard)}
                >
                  <div class={styles.projectInfo}>
                    <div class={styles.projectName}>
                      {project.matched_project?.name || project.decoded_path}
                    </div>
                    {project.matched_project && project.decoded_path !== project.matched_project.name && (
                      <div class={styles.projectPath}>{project.decoded_path}</div>
                    )}
                    <div class={styles.projectMeta}>
                      <span class={styles.badge}>{formatBytes(project.total_size)}</span>
                      <span class={styles.badge}>{formatRelativeTime(project.last_modified)}</span>
                    </div>
                  </div>
                  <div class={styles.projectCount}>
                    <span class={styles.countValue}>{project.session_count}</span>
                    <span class={styles.countLabel}>sessions</span>
                  </div>
                </Link>
              )
            })}
          </div>
        )
      })()}

      {/* Sync footer */}
      {syncStatus && (
        <div class={styles.syncFooter}>
          <div class={styles.syncInfo}>
            <span>{syncStatus.embedded_sessions} of {totalSessions} sessions embedded</span>
            <span class={styles.statSep}>&middot;</span>
            <span>{syncStatus.total_chunks} chunks indexed</span>
            {syncStatus.last_sync && (
              <>
                <span class={styles.statSep}>&middot;</span>
                <span>Last sync: {formatRelativeTime(syncStatus.last_sync)}</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
