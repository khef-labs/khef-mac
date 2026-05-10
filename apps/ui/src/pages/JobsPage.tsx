import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import { RotateCcw, XCircle, Trash2, Loader, Layers } from 'lucide-preact'
import clsx from 'clsx'
import {
  listKdagJobs,
  listJobDefinitions,
  retryKdagJob,
  cancelKdagJob,
  deleteKdagJob,
  bulkDeleteKdagJobs,
} from '../lib/api'
import { formatRelativeTime } from '../lib/format'
import type {
  KdagJob,
  JobDefinitionSummary,
  Pagination,
} from '../types'
import { ConfirmModal } from '../components/ui'
import { PageHeader } from '../components/layout'
import { useDocumentTitle } from '../hooks'
import styles from './JobsPage.module.css'

const PAGE_SIZE = 20
const POLL_INTERVAL = 3000

function formatDuration(ms: number | null): string {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  const remSecs = Math.round(secs % 60)
  return `${mins}m ${remSecs}s`
}

function statusClass(status: string): string {
  switch (status) {
    case 'queued': return styles.statusQueued
    case 'pending': return styles.statusPending
    case 'running': return styles.statusRunning
    case 'completed': return styles.statusCompleted
    case 'failed': return styles.statusFailed
    case 'canceled': return styles.statusCanceled
    default: return ''
  }
}

export function JobsPage() {
  useDocumentTitle('Jobs')
  const [, setLocation] = useLocation()
  const [jobs, setJobs] = useState<KdagJob[]>([])
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [page, setPage] = useState(0)
  const [statusFilter, setStatusFilter] = useState<string[]>([])
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({})
  const [definitions, setDefinitions] = useState<JobDefinitionSummary[]>([])
  const [definitionFilter, setDefinitionFilter] = useState<string[]>(() => {
    const params = new URLSearchParams(window.location.search)
    const val = params.get('definition_key')
    return val ? val.split(',') : []
  })
  const [defSearch, setDefSearch] = useState('')
  const [defDropdownOpen, setDefDropdownOpen] = useState(false)
  const defDropdownRef = useRef<HTMLDivElement>(null)
  const [jobSort, setJobSort] = useState('created_at:desc')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<KdagJob | null>(null)
  const [bulkDeleteIds, setBulkDeleteIds] = useState<string[] | null>(null)

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Action loading states
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({})

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load definitions for filter dropdown
  useEffect(() => {
    listJobDefinitions({ sort: 'name', order: 'asc' })
      .then((data) => setDefinitions(data.definitions))
      .catch(() => {})
  }, [])

  // Close definition dropdown on outside click
  useEffect(() => {
    if (!defDropdownOpen) return
    const handleClick = (e: MouseEvent) => {
      if (defDropdownRef.current && !defDropdownRef.current.contains(e.target as Node)) {
        setDefDropdownOpen(false)
        setDefSearch('')
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [defDropdownOpen])

  const toggleDefinitionFilter = (key: string) => {
    setDefinitionFilter((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
      // Sync URL
      const url = new URL(window.location.href)
      if (next.length > 0) url.searchParams.set('definition_key', next.join(','))
      else url.searchParams.delete('definition_key')
      window.history.replaceState(null, '', url.pathname + (url.search || ''))
      return next
    })
    setPage(0)
  }

  const clearDefinitionFilter = () => {
    setDefinitionFilter([])
    setPage(0)
    const url = new URL(window.location.href)
    url.searchParams.delete('definition_key')
    window.history.replaceState(null, '', url.pathname + (url.search || ''))
  }

  const filteredDefinitions = defSearch
    ? definitions.filter((d) => d.name.toLowerCase().includes(defSearch.toLowerCase()) || d.key.toLowerCase().includes(defSearch.toLowerCase()))
    : definitions

  const fetchJobs = useCallback(async () => {
    const [sortField, sortOrder] = jobSort.split(':')
    try {
      const data = await listKdagJobs({
        status: statusFilter.length > 0 ? statusFilter.join(',') : undefined,
        definition_key: definitionFilter.length > 0 ? definitionFilter.join(',') : undefined,
        sort: sortField,
        order: sortOrder,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      })
      setJobs(data.jobs)
      setPagination(data.pagination)
      if (data.status_counts) setStatusCounts(data.status_counts)
      setError(null)
    } catch (err) {
      console.warn('Failed to load jobs:', err)
    } finally {
      setLoaded(true)
    }
  }, [statusFilter, definitionFilter, jobSort, page])

  // Initial load + filter changes
  useEffect(() => {
    setLoaded(false)
    fetchJobs()
  }, [fetchJobs])

  // Poll while any job is running
  useEffect(() => {
    const hasRunning = jobs.some(
      (j) => j.latest_run?.status === 'pending' || j.latest_run?.status === 'running'
    )
    if (hasRunning) {
      pollRef.current = setInterval(fetchJobs, POLL_INTERVAL)
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [jobs, fetchJobs])

  const handleRetry = useCallback(async (e: Event, job: KdagJob) => {
    e.stopPropagation()
    setActionLoading((prev) => ({ ...prev, [job.id]: true }))
    try {
      await retryKdagJob(job.id)
      // Optimistically mark as running so polling kicks in
      setJobs(prev => prev.map(j =>
        j.id === job.id && j.latest_run
          ? { ...j, latest_run: { ...j.latest_run, status: 'running' as const, error: null } }
          : j
      ))
    } catch { /* ignore */ }
    setActionLoading((prev) => ({ ...prev, [job.id]: false }))
  }, [])

  const handleCancel = useCallback(async (e: Event, job: KdagJob) => {
    e.stopPropagation()
    setActionLoading((prev) => ({ ...prev, [job.id]: true }))
    try {
      await cancelKdagJob(job.id)
      await fetchJobs()
    } catch { /* ignore */ }
    setActionLoading((prev) => ({ ...prev, [job.id]: false }))
  }, [fetchJobs])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await deleteKdagJob(deleteTarget.id)
      setJobs((prev) => prev.filter((j) => j.id !== deleteTarget.id))
    } catch {
      setError('Failed to delete job')
    } finally {
      setDeleteTarget(null)
    }
  }, [deleteTarget])

  const toggleStatus = (s: string) => {
    setStatusFilter((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s])
    setPage(0)
  }

  const toggleSort = (field: string) => {
    setJobSort((prev) => {
      const [curField, curOrder] = prev.split(':')
      if (curField === field) return `${field}:${curOrder === 'desc' ? 'asc' : 'desc'}`
      return `${field}:desc`
    })
    setPage(0)
  }

  const handleBulkDelete = useCallback(async () => {
    if (!bulkDeleteIds || bulkDeleteIds.length === 0) return
    try {
      await bulkDeleteKdagJobs(bulkDeleteIds)
      setSelectedIds(new Set())
      fetchJobs()
    } catch {
      setError('Failed to delete selected jobs')
    } finally {
      setBulkDeleteIds(null)
    }
  }, [bulkDeleteIds, fetchJobs])

  // Clear selections on filter/page change
  useEffect(() => {
    setSelectedIds(new Set())
  }, [statusFilter, definitionFilter, jobSort, page])

  const selectableJobs = jobs.filter((j) => {
    const s = j.latest_run?.status
    return s !== 'running' && s !== 'queued' && s !== 'pending'
  })
  const allSelectableSelected = selectableJobs.length > 0 && selectableJobs.every((j) => selectedIds.has(j.id))
  const selectedCount = selectedIds.size

  const toggleSelection = (jobId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(jobId)) next.delete(jobId)
      else next.add(jobId)
      return next
    })
  }

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allSelectableSelected) {
        for (const j of selectableJobs) next.delete(j.id)
      } else {
        for (const j of selectableJobs) next.add(j.id)
      }
      return next
    })
  }

  const totalCount = pagination?.total_count ?? 0

  return (
    <div class={styles.page}>
      <PageHeader
        title="Jobs"
        breadcrumbs={[{ label: 'Kdag', href: '/kdag' }]}
        hideTitle
      />
      <div class={styles.header}>
        <div class={styles.headerIntro}>
          <h1 class={styles.title}>Jobs</h1>
          <p class={styles.subtitle}>Execution queue and history</p>
        </div>
        <div class={styles.headerRight}>
          {loaded && <span class={styles.count}>{totalCount} job{totalCount !== 1 ? 's' : ''}</span>}
          <div class={styles.defFilter} ref={defDropdownRef}>
            <div
              class={clsx(styles.defCombobox, defDropdownOpen && styles.defComboboxOpen)}
              onClick={() => !defDropdownOpen && setDefDropdownOpen(true)}
            >
              {definitionFilter.length > 0 && (() => {
                const MAX_VISIBLE = 2
                const visible = definitionFilter.slice(0, MAX_VISIBLE)
                const remaining = definitionFilter.length - MAX_VISIBLE
                return (
                  <>
                    {visible.map((key) => {
                      const def = definitions.find((d) => d.key === key)
                      return (
                        <span key={key} class={styles.defChip}>
                          {def?.name || key}
                          <button
                            type="button"
                            class={styles.defChipRemove}
                            onClick={(e) => { e.stopPropagation(); toggleDefinitionFilter(key) }}
                          >
                            <XCircle size={10} />
                          </button>
                        </span>
                      )
                    })}
                    {remaining > 0 && (
                      <span class={styles.defChipMore}>+{remaining}</span>
                    )}
                  </>
                )
              })()}
              <input
                type="text"
                class={styles.defComboboxInput}
                placeholder={definitionFilter.length === 0 ? 'Filter definitions...' : ''}
                value={defSearch}
                onInput={(e) => {
                  setDefSearch((e.target as HTMLInputElement).value)
                  if (!defDropdownOpen) setDefDropdownOpen(true)
                }}
                onFocus={() => setDefDropdownOpen(true)}
              />
            </div>
            {defDropdownOpen && (
              <div class={styles.defDropdown}>
                {definitionFilter.length > 0 && (
                  <button
                    type="button"
                    class={styles.defDropdownClearAll}
                    onClick={() => { clearDefinitionFilter(); setDefSearch('') }}
                  >
                    Clear all
                  </button>
                )}
                <div class={styles.defDropdownList}>
                  {filteredDefinitions.length === 0 ? (
                    <div class={styles.defDropdownEmpty}>No matches</div>
                  ) : filteredDefinitions.map((def) => (
                    <label key={def.key} class={styles.defDropdownItem}>
                      <input
                        type="checkbox"
                        class={styles.checkbox}
                        checked={definitionFilter.includes(def.key)}
                        onChange={() => toggleDefinitionFilter(def.key)}
                      />
                      <span class={styles.defDropdownName}>{def.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <a
            href="/kdag/definitions"
            class={styles.definitionsLink}
            onClick={(e) => { e.preventDefault(); setLocation('/kdag/definitions') }}
          >
            <Layers size={14} /> Definitions
          </a>
        </div>
      </div>

      <div class={styles.filters}>
        <div class={styles.statusPills}>
          {(['running', 'queued', 'pending', 'completed', 'failed', 'canceled'] as const).map((s) => (
            <button
              key={s}
              type="button"
              class={clsx(
                styles.pill,
                styles[`pill_${s}` as keyof typeof styles],
                statusFilter.includes(s) && styles.pillSelected,
              )}
              onClick={() => toggleStatus(s)}
            >
              {s} <span class={styles.pillCount}>{statusCounts[s] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {error && <div class={styles.error}>{error}</div>}

      {selectedCount > 0 && (
        <div class={styles.selectionBar}>
          <span>{selectedCount} selected</span>
          <button
            type="button"
            class={styles.selectionDeleteBtn}
            onClick={() => setBulkDeleteIds(Array.from(selectedIds))}
          >
            <Trash2 size={14} />
            Delete selected
          </button>
        </div>
      )}

      {loaded && jobs.length === 0 ? (
        <div class={styles.empty}>No jobs found.</div>
      ) : (
        <table class={styles.table}>
          <thead>
            <tr>
              <th class={styles.selectCell}>
                <input
                  type="checkbox"
                  class={styles.checkbox}
                  checked={allSelectableSelected}
                  onChange={toggleSelectAll}
                  aria-label="Select all visible jobs"
                  disabled={selectableJobs.length === 0}
                />
              </th>
              <th class={clsx(styles.typeCell, styles.sortableHeader)} onClick={() => toggleSort('type')}>
                Type{jobSort.startsWith('type:') && (jobSort.endsWith('asc') ? ' ↑' : ' ↓')}
              </th>
              <th class={styles.sortableHeader} onClick={() => toggleSort('project')}>
                Project{jobSort.startsWith('project:') && (jobSort.endsWith('asc') ? ' ↑' : ' ↓')}
              </th>
              <th class={styles.sortableHeader} onClick={() => toggleSort('status')}>
                Status{jobSort.startsWith('status:') && (jobSort.endsWith('asc') ? ' ↑' : ' ↓')}
              </th>
              <th>Progress</th>
              <th class={styles.sortableHeader} onClick={() => toggleSort('duration')}>
                Duration{jobSort.startsWith('duration:') && (jobSort.endsWith('asc') ? ' ↑' : ' ↓')}
              </th>
              <th class={styles.sortableHeader} onClick={() => toggleSort('created_at')}>
                Created{jobSort.startsWith('created_at:') && (jobSort.endsWith('asc') ? ' ↑' : ' ↓')}
              </th>
              <th class={styles.actionsCell}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const run = job.latest_run
              const isRunning = run?.status === 'running' || run?.status === 'queued' || run?.status === 'pending'
              const isFailed = run?.status === 'failed'
              const loading = actionLoading[job.id]

              return (
                <tr
                  key={job.id}
                  class={styles.row}
                  onClick={() => setLocation(`/kdag/jobs/${job.id}`)}
                >
                  <td class={styles.selectCell} onClick={(e) => e.stopPropagation()}>
                    {!isRunning ? (
                      <input
                        type="checkbox"
                        class={styles.checkbox}
                        checked={selectedIds.has(job.id)}
                        onChange={() => toggleSelection(job.id)}
                        aria-label={`Select job ${job.definition_name || job.job_type}`}
                      />
                    ) : null}
                  </td>
                  <td class={styles.typeCell}>
                    <span class={styles.typeLabel}>
                      {job.definition_name || job.job_type}
                    </span>
                    {job.definition_key && (
                      <span class={styles.defKey}>{job.definition_key}</span>
                    )}
                  </td>
                  <td>
                    {job.project_name ? (
                      <span class={styles.projectLabel}>{job.project_name}</span>
                    ) : (
                      <span class={styles.projectNone}>-</span>
                    )}
                  </td>
                  <td>
                    {run ? (
                      <span class={clsx(styles.statusBadge, statusClass(run.status))}>
                        {run.status === 'running' && <Loader size={10} class={styles.spinning} />}
                        {run.status}
                      </span>
                    ) : (
                      <span class={clsx(styles.statusBadge, styles.statusPending)}>no runs</span>
                    )}
                  </td>
                  <td>
                    {run && run.step_count > 0 ? (
                      <span class={clsx(styles.progress, isRunning && styles.progressActive)}>
                        {run.steps_completed}/{run.step_count}
                      </span>
                    ) : (
                      <span class={styles.progress}>-</span>
                    )}
                  </td>
                  <td>
                    <span class={styles.duration}>{formatDuration(run?.duration_ms ?? null)}</span>
                  </td>
                  <td>
                    <span class={styles.timestamp}>{formatRelativeTime(job.created_at)}</span>
                  </td>
                  <td class={styles.actionsCell}>
                    <div class={styles.actions} onClick={(e) => e.stopPropagation()}>
                      {isRunning && (
                        <button
                          class={clsx(styles.actionBtn, styles.actionBtnDanger)}
                          title="Cancel"
                          disabled={loading}
                          onClick={(e) => handleCancel(e, job)}
                        >
                          <XCircle size={14} />
                        </button>
                      )}
                      {isFailed && (
                        <button
                          class={styles.actionBtn}
                          title="Retry"
                          disabled={loading}
                          onClick={(e) => handleRetry(e, job)}
                        >
                          <RotateCcw size={14} />
                        </button>
                      )}
                      {!isRunning && (
                        <button
                          class={clsx(styles.actionBtn, styles.actionBtnDanger)}
                          title="Delete"
                          disabled={loading}
                          onClick={(e) => {
                            e.stopPropagation()
                            setDeleteTarget(job)
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {pagination && (pagination.total_count ?? 0) > PAGE_SIZE && (
        <div class={styles.pagination}>
          <span>
            Showing {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, pagination.total_count ?? 0)} of{' '}
            {pagination.total_count ?? 0}
          </span>
          <div class={styles.paginationButtons}>
            <button
              class={styles.paginationBtn}
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              Prev
            </button>
            <button
              class={styles.paginationBtn}
              disabled={(page + 1) * PAGE_SIZE >= (pagination.total_count ?? 0)}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
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
      {bulkDeleteIds && (
        <ConfirmModal
          title="Delete selected jobs"
          message={`Delete ${bulkDeleteIds.length} selected job${bulkDeleteIds.length === 1 ? '' : 's'}? This will remove all runs, inputs, and outputs. Jobs with active runs will be skipped.`}
          confirmLabel="Delete Selected"
          onConfirm={handleBulkDelete}
          onCancel={() => setBulkDeleteIds(null)}
        />
      )}
    </div>
  )
}
