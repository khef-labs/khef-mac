import { useState, useEffect, useCallback } from 'preact/hooks'
import { Link, useLocation } from 'wouter-preact'
import { ScrollText, RefreshCw, Search } from 'lucide-preact'
import clsx from 'clsx'
import { getSessionProjects, getSessionSyncStatus, syncSessionEmbeddings, getSyncedSession } from '../lib/api'
import { formatBytes, formatRelativeTime } from '../lib/format'
import { saveSession } from '../lib/store'
import type { SessionProject, SessionSyncStatus } from '../types'
import { cardStyles, useToast } from '../components/ui'
import { ActiveSessionsBanner } from '../components/session'
import styles from './SessionProjectsPage.module.css'

interface Props {
  handle: string
  embedded?: boolean
}

export function SessionProjectsPage({ handle, embedded }: Props) {
  const { showToast } = useToast()
  const [, setLocation] = useLocation()
  const [projects, setProjects] = useState<SessionProject[]>([])
  const [totalSize, setTotalSize] = useState(0)
  const [totalSessions, setTotalSessions] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Session ID lookup
  const [sessionIdQuery, setSessionIdQuery] = useState('')
  const [lookupLoading, setLookupLoading] = useState(false)

  // Sync embeddings state
  const [syncStatus, setSyncStatus] = useState<SessionSyncStatus | null>(null)

  useEffect(() => {
    let mounted = true
    setIsLoading(true)
    setError(null)

    getSessionProjects(handle)
      .then((data) => {
        if (!mounted) return
        setProjects(data.projects || [])
        setTotalSize(data.total_size || 0)
        setTotalSessions(data.total_sessions || 0)
      })
      .catch((err) => {
        if (!mounted) return
        console.warn('Failed to load session projects:', err)
      })
      .finally(() => {
        if (mounted) setIsLoading(false)
      })

    return () => { mounted = false }
  }, [handle])

  // Fetch sync status
  useEffect(() => {
    getSessionSyncStatus(handle)
      .then(setSyncStatus)
      .catch(() => {})
  }, [handle])

  // Handle sync (fire and forget)
  const handleSync = useCallback(() => {
    showToast('Sync requested...')

    syncSessionEmbeddings(handle)
      .then((result) => {
        const msg = `Sync complete: ${result.synced} synced, ${result.skipped} skipped`
        showToast(result.errors > 0 ? `${msg}, ${result.errors} errors` : msg)
        return getSessionSyncStatus(handle)
      })
      .then(setSyncStatus)
      .catch((err: any) => {
        showToast(err.message || 'Sync failed')
      })
  }, [handle, showToast])

  const handleSessionLookup = useCallback(async () => {
    const q = sessionIdQuery.trim()
    if (!q) return
    setLookupLoading(true)
    try {
      const data = await getSyncedSession(q, false)
      if (data.session) {
        saveSession({ sessionBackUrl: `/assistants/${handle}/sessions` })
        setLocation(`/sessions/${data.session.id}`)
      }
    } catch {
      showToast('Session not found')
    } finally {
      setLookupLoading(false)
    }
  }, [sessionIdQuery, handle, setLocation, showToast])

  if (isLoading) {
    return (
      <div class={embedded ? undefined : styles.page}>
        <div class={styles.loading}>Loading sessions...</div>
      </div>
    )
  }

  return (
    <div class={embedded ? undefined : styles.page}>
      {!embedded && (
        <div class={styles.header}>
          <div class={styles.titleRow}>
            <h1 class={styles.title}>Sessions</h1>
            <button
              class={styles.syncButton}
              onClick={handleSync}
              title="Sync session embeddings for search"
            >
              <RefreshCw size={14} />
              Sync Embeddings
            </button>
          </div>
          <p class={styles.subtitle}>
            {totalSessions} session{totalSessions !== 1 ? 's' : ''} across {projects.length} project{projects.length !== 1 ? 's' : ''} · {formatBytes(totalSize)}
            {syncStatus && (
              <span class={styles.syncInfo}>
                {' '}· {syncStatus.embedded_sessions} embedded ({syncStatus.total_chunks} chunks)
                {syncStatus.last_sync && ` · Last sync: ${formatRelativeTime(syncStatus.last_sync)}`}
              </span>
            )}
          </p>
          <div class={styles.searchRow}>
            <Search size={14} class={styles.searchIcon} />
            <input
              type="text"
              class={styles.searchInput}
              placeholder="Look up by session ID..."
              value={sessionIdQuery}
              onInput={(e) => setSessionIdQuery((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSessionLookup() }}
              disabled={lookupLoading}
            />
          </div>
        </div>
      )}

      <ActiveSessionsBanner assistantHandle={handle} />

      {error && <div class={styles.error}>{error}</div>}

      {projects.length === 0 ? (
        <div class={styles.empty}>No session transcripts found.</div>
      ) : (
        <div class={styles.projectList}>
          {projects.map((project) => {
            const href = project.matched_project
              ? `/projects/${project.matched_project.id}/sessions`
              : `/assistants/${handle}/sessions/${encodeURIComponent(project.dir_name)}`
            return (
              <Link
                key={project.dir_name}
                href={href}
                class={clsx(cardStyles.card, cardStyles.interactive, styles.projectCard)}
              >
                <div class={styles.projectName}>
                  <ScrollText size={14} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '6px', color: 'var(--muted)' }} />
                  {project.matched_project?.name || project.decoded_path}
                </div>
                {project.matched_project && project.decoded_path !== project.matched_project.name && (
                  <div class={styles.projectPath}>{project.decoded_path}</div>
                )}
                <div class={styles.projectMeta}>
                  <span class={styles.badge}>
                    {project.session_count} session{project.session_count !== 1 ? 's' : ''}
                  </span>
                  <span class={styles.badge}>{formatBytes(project.total_size)}</span>
                  <span class={styles.badge}>{formatRelativeTime(project.last_modified)}</span>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
