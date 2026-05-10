import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import { Plus, Shield, Trash2, Play, Search, EyeOff } from 'lucide-preact'
import {
  listJobDefinitions,
  deleteJobDefinition,
  getJobDefinition,
  createKdagJob,
  runKdagJob,
} from '../lib/api'
import { loadSettings, saveSettings } from '../lib/settings'
import { formatRelativeTime } from '../lib/format'
import type { JobDefinitionSummary, JobDefinitionInput } from '../types'
import { ConfirmModal, useToast, ModelCombobox } from '../components/ui'
import { PageHeader } from '../components/layout'
import { useKdagBackends } from '../hooks/useKdagBackends'
import { useDocumentTitle } from '../hooks'
import styles from './DefinitionsPage.module.css'

interface RunModalProps {
  definition: JobDefinitionSummary
  onClose: () => void
  onCreated: (jobId: string) => void
}

function RunModal({ definition, onClose, onCreated }: RunModalProps) {
  const [defInputs, setDefInputs] = useState<JobDefinitionInput[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const { backends } = useKdagBackends()
  const availableBackends = useMemo(() => {
    const available = backends.filter(b => b.available)
    return available.length > 0 ? available : [{ key: 'claude-code', name: 'Claude Code', available: true, models: [] as string[] }]
  }, [backends])
  const [assistant, setAssistant] = useState('claude-code')
  const [model, setModel] = useState('')
  const selectedBackend = useMemo(() => backends.find(b => b.key === assistant), [backends, assistant])

  useEffect(() => {
    async function load() {
      try {
        const data = await getJobDefinition(definition.key)
        setDefInputs(data.inputs)
        // Pre-fill empty values for each input
        const initial: Record<string, string> = {}
        for (const inp of data.inputs) {
          initial[inp.input_type] = ''
        }
        setValues(initial)
      } catch {
        setError('Failed to load definition inputs')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [definition.key])

  const handleSubmit = useCallback(async () => {
    // Validate required inputs
    for (const inp of defInputs) {
      if (inp.required && !values[inp.input_type]?.trim()) {
        setError(`"${inp.input_type.replace(/_/g, ' ')}" is required`)
        return
      }
    }

    setSubmitting(true)
    setError(null)

    try {
      const modelOpt = model || undefined
      const result = await createKdagJob({
        definition_key: definition.key,
        assistant_handle: assistant,
        model: modelOpt,
        inputs: values,
      })
      // Auto-run the job
      await runKdagJob(result.job.id, { model: modelOpt })
      onCreated(result.job.id)
    } catch (err: any) {
      const msg = err?.response ? await err.response.text().catch(() => err.message) : err?.message
      setError(typeof msg === 'string' ? msg : 'Failed to create job')
      setSubmitting(false)
    }
  }, [defInputs, values, definition.key, assistant, model, onCreated])

  const inputLabel = (key: string) => key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

  return (
    <div class={styles.overlay} onClick={onClose}>
      <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div class={styles.modalHeader}>
          <h2 class={styles.modalTitle}>Run: {definition.name}</h2>
          <span class={styles.modalKey}>{definition.key}</span>
        </div>

        <div class={styles.modalAssistant}>
          <label class={styles.modalLabel}>Assistant</label>
          <select
            class={styles.modalSelect}
            value={assistant}
            onChange={(e) => {
              setAssistant((e.target as HTMLSelectElement).value)
              setModel('')
            }}
          >
            {availableBackends.map(b => (
              <option key={b.key} value={b.key}>{b.name}</option>
            ))}
          </select>
          <ModelCombobox
            value={model}
            onChange={setModel}
            models={selectedBackend?.models || []}
          />
        </div>

        {loading ? (
          <div class={styles.modalLoading}>Loading inputs...</div>
        ) : defInputs.length === 0 ? (
          <p class={styles.modalHint}>This definition has no declared inputs. It will run with defaults.</p>
        ) : (
          <div class={styles.modalBody}>
            {defInputs.map(inp => (
              <div key={inp.input_type} class={styles.modalField}>
                <label class={styles.modalLabel}>
                  {inputLabel(inp.input_type)}
                  {inp.required ? (
                    <span class={styles.modalReq}>required</span>
                  ) : (
                    <span class={styles.modalOpt}>optional</span>
                  )}
                </label>
                {inp.description && (
                  <p class={styles.modalFieldHint}>{inp.description}</p>
                )}
                <textarea
                  class={styles.modalTextarea}
                  value={values[inp.input_type] || ''}
                  onInput={(e) => setValues(prev => ({
                    ...prev,
                    [inp.input_type]: (e.target as HTMLTextAreaElement).value,
                  }))}
                  rows={inp.input_type === 'transcript' ? 8 : 4}
                  placeholder={`Enter ${inputLabel(inp.input_type).toLowerCase()}...`}
                />
              </div>
            ))}
          </div>
        )}

        {error && <div class={styles.modalError}>{error}</div>}

        <div class={styles.modalActions}>
          <button class={styles.modalCancelBtn} onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            class={styles.modalRunBtn}
            onClick={handleSubmit}
            disabled={loading || submitting}
          >
            <Play size={12} />
            {submitting ? 'Starting...' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  )
}

const PAGE_SIZE = 20

export function DefinitionsPage() {
  useDocumentTitle('Definitions')
  const [, setLocation] = useLocation()
  const { showToast } = useToast()
  const [allDefinitions, setAllDefinitions] = useState<JobDefinitionSummary[]>([])
  const [page, setPage] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<JobDefinitionSummary | null>(null)
  const [runTarget, setRunTarget] = useState<JobDefinitionSummary | null>(null)
  const [defSort, setDefSort] = useState('name:asc')
  const [searchQuery, setSearchQuery] = useState('')

  // Sort and filter client-side over the full dataset
  const sortedDefs = useMemo(() => {
    const [sortField, sortOrder] = defSort.split(':')
    const sorted = [...allDefinitions].sort((a, b) => {
      let aVal: string | number = ''
      let bVal: string | number = ''
      if (sortField === 'name') {
        aVal = a.name.toLowerCase()
        bVal = b.name.toLowerCase()
      } else if (sortField === 'updated_at' || sortField === 'created_at') {
        aVal = a[sortField] || ''
        bVal = b[sortField] || ''
      }
      if (aVal < bVal) return sortOrder === 'asc' ? -1 : 1
      if (aVal > bVal) return sortOrder === 'asc' ? 1 : -1
      return 0
    })
    return sorted
  }, [allDefinitions, defSort])

  const filteredDefs = useMemo(() => {
    if (!searchQuery.trim()) return sortedDefs
    const q = searchQuery.toLowerCase()
    return sortedDefs.filter(d =>
      d.name.toLowerCase().includes(q) ||
      d.key.toLowerCase().includes(q) ||
      (d.description && d.description.toLowerCase().includes(q))
    )
  }, [sortedDefs, searchQuery])

  const totalFiltered = filteredDefs.length
  const pagedDefs = useMemo(() => {
    const start = page * PAGE_SIZE
    return filteredDefs.slice(start, start + PAGE_SIZE)
  }, [filteredDefs, page])

  const fetchDefinitions = useCallback(async () => {
    try {
      const data = await listJobDefinitions({
        sort: 'name',
        order: 'asc',
        limit: 200,
        offset: 0,
      })
      setAllDefinitions(data.definitions)
      setError(null)
    } catch (err) {
      console.warn('Failed to load definitions:', err)
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    fetchDefinitions()
  }, [fetchDefinitions])

  // Reset page when search or sort changes
  useEffect(() => { setPage(0) }, [searchQuery, defSort])

  // Keyboard pagination: left/right arrow keys
  useEffect(() => {
    if (totalFiltered <= PAGE_SIZE) return
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'ArrowLeft' && page > 0) {
        e.preventDefault()
        setPage(p => p - 1)
      } else if (e.key === 'ArrowRight' && (page + 1) * PAGE_SIZE < totalFiltered) {
        e.preventDefault()
        setPage(p => p + 1)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [page, totalFiltered])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await deleteJobDefinition(deleteTarget.key)
      setAllDefinitions(prev => prev.filter(d => d.key !== deleteTarget.key))
    } catch (err: any) {
      setError(err?.message || 'Failed to delete definition')
    } finally {
      setDeleteTarget(null)
    }
  }, [deleteTarget])

  const handleHide = useCallback(async (def: JobDefinitionSummary) => {
    try {
      const cur = await loadSettings()
      const hidden = cur.kdag.definitions.hidden
      const next = hidden.includes(def.key) ? hidden : [...hidden, def.key]
      await saveSettings({
        kdag: {
          maxConcurrency: cur.kdag.maxConcurrency,
          allowedTools: cur.kdag.allowedTools,
          definitions: { hidden: next },
        },
      })
      setAllDefinitions(prev => prev.filter(d => d.key !== def.key))
      showToast(`Hid "${def.name}" — toggle in Settings → Definitions`)
    } catch (err: any) {
      setError(err?.message || 'Failed to hide definition')
    }
  }, [showToast])

  const handleJobCreated = useCallback((jobId: string) => {
    showToast('Job started')
    setRunTarget(null)
    setLocation(`/kdag/jobs/${jobId}`)
  }, [setLocation, showToast])

  return (
    <div class={styles.page}>
      <PageHeader
        title="Definitions"
        breadcrumbs={[{ label: 'Kdag', href: '/kdag' }]}
        hideTitle
      />
      <div class={styles.header}>
        <div class={styles.headerLeft}>
          <div class={styles.headerIntro}>
            <h1 class={styles.title}>Pipeline Definitions</h1>
            <p class={styles.subtitle}>Reusable multi-step job blueprints</p>
          </div>
        </div>
        <div class={styles.headerActions}>
          <div class={styles.searchWrapper}>
            <Search size={14} class={styles.searchIcon} />
            <input
              type="text"
              class={styles.searchInput}
              placeholder="Filter definitions..."
              value={searchQuery}
              onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
            />
          </div>
          <select
            class={styles.sortSelect}
            value={defSort}
            onChange={(e) => setDefSort((e.target as HTMLSelectElement).value)}
            title="Sort definitions"
          >
            <option value="updated_at:desc">Updated ↓</option>
            <option value="updated_at:asc">Updated ↑</option>
            <option value="created_at:desc">Created ↓</option>
            <option value="created_at:asc">Created ↑</option>
            <option value="name:asc">Name A–Z</option>
            <option value="name:desc">Name Z–A</option>
          </select>
          <button
            class={styles.createBtn}
            onClick={() => setLocation('/kdag/definitions/new')}
          >
            <Plus size={14} /> New Definition
          </button>
        </div>
      </div>

      {error && <div class={styles.error}>{error}</div>}

      {loaded && pagedDefs.length === 0 ? (
        <div class={styles.empty}>
          {searchQuery ? `No definitions matching "${searchQuery}"` : 'No definitions found.'}
        </div>
      ) : (
        <div class={styles.grid}>
          {pagedDefs.map(def => (
            <div
              key={def.key}
              class={styles.card}
              onClick={() => setLocation(`/kdag/definitions/${def.key}`)}
            >
              <div class={styles.cardHeader}>
                <div class={styles.cardTitle}>
                  {def.name}
                  {def.is_system && (
                    <span class={styles.systemBadge} title="System definition">
                      <Shield size={10} /> System
                    </span>
                  )}
                </div>
                <span class={styles.cardKey}>{def.key}</span>
              </div>

              {def.description && (
                <p class={styles.cardDesc}>{def.description}</p>
              )}

              <div class={styles.cardMeta}>
                <span class={styles.cardStat}>{def.step_count} step{def.step_count !== 1 ? 's' : ''}</span>
                <span class={styles.cardStat}>{def.job_count} job{def.job_count !== 1 ? 's' : ''}</span>
                <span class={styles.cardTime}>{formatRelativeTime(def.updated_at)}</span>
              </div>

              <div class={styles.cardActions} onClick={(e) => e.stopPropagation()}>
                <button
                  class={styles.runBtn}
                  title="Run this definition"
                  onClick={() => setRunTarget(def)}
                >
                  <Play size={12} /> Run
                </button>
                <button
                  class={styles.hideBtn}
                  title="Hide from this page (toggle in Settings → Definitions)"
                  onClick={() => handleHide(def)}
                >
                  <EyeOff size={12} />
                </button>
                {!def.is_system && (
                  <button
                    class={styles.deleteBtn}
                    title="Delete"
                    onClick={() => setDeleteTarget(def)}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {totalFiltered > PAGE_SIZE && (
        <div class={styles.pagination}>
          <span>
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalFiltered)} of{' '}
            {totalFiltered}
          </span>
          <div class={styles.paginationButtons}>
            <button
              class={styles.paginationBtn}
              disabled={page === 0}
              onClick={() => setPage(p => p - 1)}
            >
              Prev
            </button>
            <button
              class={styles.paginationBtn}
              disabled={(page + 1) * PAGE_SIZE >= totalFiltered}
              onClick={() => setPage(p => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete definition"
          message={`Delete "${deleteTarget.name}"? This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {runTarget && (
        <RunModal
          definition={runTarget}
          onClose={() => setRunTarget(null)}
          onCreated={handleJobCreated}
        />
      )}
    </div>
  )
}
