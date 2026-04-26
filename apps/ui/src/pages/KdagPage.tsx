import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import { Loader, Play, Shield, CheckCircle, XCircle, Clock, List, Layers, Copy, ExternalLink, RotateCcw, Trash2 } from 'lucide-preact'
import { PageHeader } from '../components/layout'
import type { HeaderAction } from '../components/layout'
import clsx from 'clsx'
import {
  listKdagJobs,
  listJobDefinitions,
  getJobDefinition,
  retryKdagJob,
  cancelKdagJob,
  deleteKdagJob,
} from '../lib/api'
import { formatRelativeTime } from '../lib/format'
import type {
  KdagJob,
  JobDefinitionSummary,
} from '../types'
import { useToast, ConfirmModal, SortBar } from '../components/ui'
import type { SortField, SortState } from '../components/ui'

const DEF_SORT_FIELDS: SortField[] = [
  { key: 'last_used', label: 'Last Used' },
  { key: 'updated_at', label: 'Updated' },
  { key: 'created_at', label: 'Created' },
  { key: 'name', label: 'Name' },
]
import { RunModal } from '../components/kdag/RunModal'
import { useDocumentTitle } from '../hooks'
import styles from './KdagPage.module.css'

const POLL_INTERVAL = 5000

type StatusFilter = 'all' | 'active' | 'queued' | 'pending' | 'failed' | 'completed'

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  const remSecs = Math.round(secs % 60)
  return `${mins}m ${remSecs}s`
}

export function KdagPage() {
  useDocumentTitle('Kdag')
  const [, setLocation] = useLocation()
  const { showToast } = useToast()
  const [recentJobs, setRecentJobs] = useState<KdagJob[]>([])
  const [definitions, setDefinitions] = useState<JobDefinitionSummary[]>([])
  const [totalJobs, setTotalJobs] = useState(0)
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({})
  const [loaded, setLoaded] = useState(false)
  const [runTarget, setRunTarget] = useState<{ key: string; name: string; inputs: import('../types').JobDefinitionInput[] } | null>(null)
  const [defSort, setDefSort] = useState<SortState>({ field: 'last_used', direction: 'desc' })
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')
  const [contextMenu, setContextMenu] = useState<{ job: KdagJob; x: number; y: number } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<KdagJob | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const [jobsData, defsData] = await Promise.all([
        listKdagJobs({ status: statusFilter !== 'all' ? statusFilter : undefined, limit: 8 }),
        listJobDefinitions({ sort: defSort.field, order: defSort.direction }),
      ])
      setRecentJobs(jobsData.jobs)
      const counts = jobsData.status_counts ?? {}
      setStatusCounts(counts)
      setTotalJobs(Object.values(counts).reduce((sum, n) => sum + n, 0))
      setDefinitions(defsData.definitions)
    } catch { /* ignore */ }
    finally { setLoaded(true) }
  }, [defSort, statusFilter])

  useEffect(() => { fetchData() }, [fetchData])

  // Poll while any job is running (use API counts so polling works regardless of filter)
  useEffect(() => {
    const hasActive = (statusCounts['running'] ?? 0) > 0 || (statusCounts['queued'] ?? 0) > 0
    if (hasActive) {
      pollRef.current = setInterval(fetchData, POLL_INTERVAL)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [statusCounts, fetchData])

  const handleJobCreated = useCallback((jobId: string) => {
    showToast('Job started')
    setRunTarget(null)
    setLocation(`/kdag/jobs/${jobId}`)
  }, [setLocation, showToast])

  // Context menu: close on outside click, escape, scroll
  useEffect(() => {
    if (!contextMenu) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setContextMenu(null)
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    const handleScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return
      setContextMenu(null)
    }
    const timer = setTimeout(() => document.addEventListener('click', handleClick), 0)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', handleClick)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [contextMenu])

  const handleContextMenu = useCallback((e: MouseEvent, job: KdagJob) => {
    e.preventDefault()
    const menuWidth = 180, menuHeight = 200, pad = 8
    let x = e.clientX, y = e.clientY
    if (x + menuWidth + pad > window.innerWidth) x = window.innerWidth - menuWidth - pad
    if (y + menuHeight + pad > window.innerHeight) y = window.innerHeight - menuHeight - pad
    if (x < pad) x = pad
    if (y < pad) y = pad
    setContextMenu({ job, x, y })
  }, [])

  const handleRetry = useCallback(async (job: KdagJob) => {
    try {
      await retryKdagJob(job.id)
      showToast('Job retried')
      fetchData()
    } catch { showToast('Failed to retry job') }
  }, [fetchData, showToast])

  const handleCancel = useCallback(async (job: KdagJob) => {
    try {
      await cancelKdagJob(job.id)
      showToast('Job canceled')
      fetchData()
    } catch { showToast('Failed to cancel job') }
  }, [fetchData, showToast])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await deleteKdagJob(deleteTarget.id)
      showToast('Job deleted')
      fetchData()
    } catch { showToast('Failed to delete job') }
    finally { setDeleteTarget(null) }
  }, [deleteTarget, fetchData, showToast])

  // Stats from API counts
  const activeJobs = statusCounts['running'] ?? 0
  const queuedJobs = statusCounts['queued'] ?? 0
  const pendingJobs = statusCounts['pending'] ?? 0
  const failedJobs = statusCounts['failed'] ?? 0
  const completedJobs = statusCounts['completed'] ?? 0



  if (!loaded) {
    return (
      <div class={styles.page}>
        <div class={styles.loading}><Loader size={16} class={styles.spinning} /> Loading...</div>
      </div>
    )
  }

  return (
    <div class={styles.page}>
      {/* Header */}
      <PageHeader
        title="Kdag"
        subtitle="Pipeline orchestration"
        actions={[
          { key: 'jobs', href: '/kdag/jobs', icon: List, label: 'Jobs' },
          { key: 'definitions', href: '/kdag/definitions', icon: Layers, label: 'Definitions' },
        ] satisfies HeaderAction[]}
      >
        {activeJobs > 0 && (
          <div class={styles.liveIndicator}>
            <span class={styles.liveDot} />
            {activeJobs} running
          </div>
        )}
      </PageHeader>

      {/* Status filter pills */}
      <div class={styles.filterBar}>
        <button
          class={clsx(styles.pill, styles.pillActive, statusFilter === 'active' && styles.pillSelected)}
          onClick={() => setStatusFilter('active')}
        >
          {activeJobs > 0 && <span class={styles.activePulseDot} />}
          Running <span class={styles.pillCount}>{formatCount(activeJobs)}</span>
        </button>
        <button
          class={clsx(styles.pill, styles.pillQueued, statusFilter === 'queued' && styles.pillSelected)}
          onClick={() => setStatusFilter('queued')}
        >
          Queued <span class={styles.pillCount}>{formatCount(queuedJobs)}</span>
        </button>
        <button
          class={clsx(styles.pill, styles.pillPending, statusFilter === 'pending' && styles.pillSelected)}
          onClick={() => setStatusFilter('pending')}
        >
          Pending <span class={styles.pillCount}>{formatCount(pendingJobs)}</span>
        </button>
        <button
          class={clsx(styles.pill, styles.pillFailed, statusFilter === 'failed' && styles.pillSelected)}
          onClick={() => setStatusFilter('failed')}
        >
          Failed <span class={styles.pillCount}>{formatCount(failedJobs)}</span>
        </button>
        <button
          class={clsx(styles.pill, styles.pillCompleted, statusFilter === 'completed' && styles.pillSelected)}
          onClick={() => setStatusFilter('completed')}
        >
          Completed <span class={styles.pillCount}>{formatCount(completedJobs)}</span>
        </button>
        <button
          class={clsx(styles.pill, styles.pillAll, statusFilter === 'all' && styles.pillSelected)}
          onClick={() => setStatusFilter('all')}
        >
          All <span class={styles.pillCount}>{formatCount(totalJobs)}</span>
        </button>
      </div>

      {/* Two-column layout: recent jobs + definitions */}
      <div class={styles.columns}>
        {/* Recent jobs — timeline feed */}
        <div class={styles.section}>
          <div class={styles.sectionHeader}>
            <div class={styles.sectionTitleGroup}>
              <span class={styles.sectionTitle}>Jobs</span>
              <span class={styles.sectionCount}>({recentJobs.length})</span>
            </div>
          </div>
          {recentJobs.length === 0 ? (
            <div class={styles.emptySection}>
              {statusFilter === 'all' ? 'No jobs yet' : `No ${statusFilter} jobs`}
            </div>
          ) : (
            <div class={styles.jobFeed}>
              {recentJobs.map((job, idx) => {
                const run = job.latest_run
                const status = run?.status || 'pending'
                const isLast = idx === recentJobs.length - 1
                const isRunningOrPending = status === 'running' || status === 'queued' || status === 'pending'
                const progressPct = run && run.step_count > 0
                  ? Math.round((run.steps_completed / run.step_count) * 100)
                  : 0

                return (
                  <div
                    key={job.id}
                    class={clsx(styles.jobRow, isLast && styles.jobRowLast)}
                    onClick={() => setLocation(`/kdag/jobs/${job.id}`)}
                    onContextMenu={(e) => handleContextMenu(e as unknown as MouseEvent, job)}
                  >
                    {/* Timeline rail */}
                    <div class={styles.jobRail}>
                      <div class={clsx(
                        styles.jobDot,
                        status === 'running' && styles.jobDotRunning,
                        status === 'completed' && styles.jobDotCompleted,
                        status === 'failed' && styles.jobDotFailed,
                        status === 'queued' && styles.jobDotQueued,
                        status === 'pending' && styles.jobDotPending,
                      )} />
                      <div class={clsx(
                        styles.jobLine,
                        status === 'running' && styles.jobLineRunning,
                      )} />
                    </div>

                    {/* Body */}
                    <div class={styles.jobBody}>
                      <span class={styles.jobName}>
                        {job.definition_name || job.job_type}
                      </span>
                      {job.project_name && (
                        <span class={styles.jobProject}>{job.project_name}</span>
                      )}
                      {isRunningOrPending && run && run.step_count > 0 && (
                        <div class={styles.jobProgress}>
                          <div class={styles.jobTrack}>
                            <div class={styles.jobFill} style={{ width: `${progressPct}%` }} />
                          </div>
                          <span class={styles.jobProgressText}>
                            {run.steps_completed}/{run.step_count} steps
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Right column */}
                    <div class={styles.jobRight}>
                      <span class={clsx(
                        styles.jobBadge,
                        status === 'running' && styles.badgeRunning,
                        status === 'completed' && styles.badgeCompleted,
                        status === 'failed' && styles.badgeFailed,
                        status === 'queued' && styles.badgeQueued,
                        status === 'pending' && styles.badgePending,
                      )}>
                        {status === 'running' && <span class={styles.miniSpinner} />}
                        {status === 'completed' && <CheckCircle size={10} />}
                        {status === 'failed' && <XCircle size={10} />}
                        {status === 'queued' && <Clock size={10} />}
                        {status === 'pending' && <Clock size={10} />}
                        {status}
                      </span>
                      {run?.duration_ms != null && (
                        <span class={styles.jobDuration}>{formatDuration(run.duration_ms)}</span>
                      )}
                      <span class={styles.jobTime}>{formatRelativeTime(job.created_at)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Definitions */}
        <div class={styles.section}>
          <div class={styles.sectionHeader}>
            <div class={styles.sectionTitleGroup}>
              <span class={styles.sectionTitle}>Definitions</span>
              <span class={styles.sectionCount}>({definitions.length})</span>
            </div>
            <div class={styles.sectionHeaderRight}>
              <SortBar fields={DEF_SORT_FIELDS} value={defSort} onChange={setDefSort} />
            </div>
          </div>
          {definitions.length === 0 ? (
            <div class={styles.emptySection}>No definitions yet</div>
          ) : (
            <div class={styles.defList}>
              {definitions.map(def => (
                <div
                  key={def.key}
                  class={styles.defCard}
                  onClick={() => setLocation(`/kdag/definitions/${def.key}`)}
                >
                  <div class={styles.defTop}>
                    <span class={styles.defName}>{def.name}</span>
                    {def.is_system && (
                      <span class={styles.defSystemBadge}>
                        <Shield size={8} />
                        system
                      </span>
                    )}
                  </div>
                  {def.description && (
                    <span class={styles.defDesc}>{def.description}</span>
                  )}
                  <div class={styles.defFooter}>
                    <div class={styles.defMeta}>
                      <span>{def.step_count} step{def.step_count !== 1 ? 's' : ''}</span>
                      <span>{def.job_count} job{def.job_count !== 1 ? 's' : ''}</span>
                    </div>
                    <button
                      class={styles.defRunBtn}
                      onClick={async (e) => { e.stopPropagation(); const data = await getJobDefinition(def.key); setRunTarget({ key: def.key, name: def.name, inputs: data.inputs }) }}
                    >
                      <Play size={10} /> Run
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {runTarget && (
        <RunModal
          definitionKey={runTarget.key}
          definitionName={runTarget.name}
          inputs={runTarget.inputs}
          onClose={() => setRunTarget(null)}
          onCreated={handleJobCreated}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete job"
          message={`Delete this ${deleteTarget.job_type} job? This will remove all runs, inputs, and outputs.`}
          confirmLabel="Delete"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {contextMenu && (() => {
        const job = contextMenu.job
        const run = job.latest_run
        const isRunning = run?.status === 'running' || run?.status === 'pending'
        const isFailed = run?.status === 'failed'
        return (
          <div
            ref={menuRef}
            class={styles.contextMenu}
            style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              class={styles.contextMenuItem}
              onClick={() => { setLocation(`/kdag/jobs/${job.id}`); setContextMenu(null) }}
            >
              <span>View Details</span>
              <ExternalLink size={14} />
            </button>
            <button
              type="button"
              class={styles.contextMenuItem}
              onClick={async () => {
                try { await navigator.clipboard.writeText(job.id) } catch { /* ignore */ }
                showToast('Job ID copied')
                setContextMenu(null)
              }}
            >
              <span>Copy Job ID</span>
              <Copy size={14} />
            </button>
            {isFailed && (
              <>
                <div class={styles.contextMenuDivider} />
                <button
                  type="button"
                  class={styles.contextMenuItem}
                  onClick={() => { const j = contextMenu.job; setContextMenu(null); handleRetry(j) }}
                >
                  <span>Retry</span>
                  <RotateCcw size={14} />
                </button>
              </>
            )}
            {isRunning && (
              <>
                <div class={styles.contextMenuDivider} />
                <button
                  type="button"
                  class={clsx(styles.contextMenuItem, styles.contextMenuDanger)}
                  onClick={() => { const j = contextMenu.job; setContextMenu(null); handleCancel(j) }}
                >
                  <span>Cancel</span>
                  <XCircle size={14} />
                </button>
              </>
            )}
            {!isRunning && (
              <>
                <div class={styles.contextMenuDivider} />
                <button
                  type="button"
                  class={clsx(styles.contextMenuItem, styles.contextMenuDanger)}
                  onClick={() => { const j = contextMenu.job; setContextMenu(null); setDeleteTarget(j) }}
                >
                  <span>Delete</span>
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </div>
        )
      })()}
    </div>
  )
}
