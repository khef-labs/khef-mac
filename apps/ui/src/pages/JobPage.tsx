import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import { RotateCcw, Play, XCircle, Trash2, Loader, ChevronRight, ChevronDown, Save, X, Copy, Check, Download, FastForward, FileText, MessageSquareText } from 'lucide-preact'
import clsx from 'clsx'
import Papa from 'papaparse'
import yaml from 'js-yaml'
import {
  getKdagJob,
  runKdagJob,
  retryKdagJob,
  rerunKdagJobFromStep,
  cancelKdagJob,
  deleteKdagJob,
  createMemory,
  getProjects,
  getMemoryTypes,
  type MemoryTypeListItem,
} from '../lib/api'
import { formatRelativeTime } from '../lib/format'
import { getTypeLabel, buildTypeHierarchy } from '../lib/memoryTypes'
import type {
  KdagJobDetailResponse,
  KdagJobStep,
  Project,
} from '../types'
import { ConfirmModal, CopyButton, useToast, ModelCombobox } from '../components/ui'
import { PageHeader } from '../components/layout'
import { useDocumentTitle } from '../hooks'
import { useKdagBackends } from '../hooks/useKdagBackends'
import styles from './JobPage.module.css'

const POLL_INTERVAL = 3000

interface Props {
  id: string
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

function formatChars(chars: number): string {
  if (chars < 1000) return `${chars} chars`
  const k = chars / 1000
  if (k < 1000) return `${k.toFixed(1)}k chars`
  const m = k / 1000
  return `${m.toFixed(1)}M chars`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(1)} MB`
}

function stepLabel(step: KdagJobStep, allSteps: KdagJobStep[]): string {
  if (step.step_type === 'synthesis') return 'Synthesis'
  if (step.step_type === 'batch_summary') {
    // Count batch steps within the same definition step
    const siblings = allSteps.filter(
      s => s.definition_step_index === step.definition_step_index && s.step_type === 'batch_summary'
    )
    return `Batch ${step.step_index + 1} of ${siblings.length}`
  }
  return step.step_type.replace(/_/g, ' ')
}

function stepFileSlug(step: KdagJobStep): string {
  const n = step.definition_step_index + 1
  if (step.step_type === 'synthesis') return `step-${n}-synthesis`
  if (step.step_type === 'batch_summary') return `step-${n}-batch-${step.step_index + 1}`
  return `step-${n}`
}

function statusClass(status: string): string {
  switch (status) {
    case 'pending': return styles.statusPending
    case 'running': return styles.statusRunning
    case 'completed': return styles.statusCompleted
    case 'failed': return styles.statusFailed
    case 'canceled': return styles.statusCanceled
    default: return ''
  }
}

export function JobPage({ id }: Props) {
  const [, setLocation] = useLocation()

  const [detail, setDetail] = useState<KdagJobDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [expandedPanels, setExpandedPanels] = useState<Set<string>>(new Set())
  const [expandedInputs, setExpandedInputs] = useState<Set<string>>(new Set())
  const [expandedBatchGroups, setExpandedBatchGroups] = useState<Set<string>>(new Set())
  const [selectedRunIndex, setSelectedRunIndex] = useState(0)

  const { backends } = useKdagBackends()
  const availableBackends = useMemo(() => backends.filter(b => b.available), [backends])
  const [selectedAssistant, setSelectedAssistant] = useState<string>('')
  const [selectedModel, setSelectedModel] = useState('')
  const selectedBackend = useMemo(() => backends.find(b => b.key === selectedAssistant), [backends, selectedAssistant])
  const [selectedTimeout, setSelectedTimeout] = useState<string>('120000')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)

  const { showToast } = useToast()

  // Save as Memory modal state
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [saveProjects, setSaveProjects] = useState<Project[]>([])
  const [saveMemoryTypes, setSaveMemoryTypes] = useState<MemoryTypeListItem[]>([])
  const [saveTypeHierarchy, setSaveTypeHierarchy] = useState<Record<string, string[]>>({})
  const [saveProjectId, setSaveProjectId] = useState('')
  const [saveTitle, setSaveTitle] = useState('')
  const [saveHandle, setSaveHandle] = useState('')
  const [saveType, setSaveType] = useState('project-note')
  const [saveSubtype, setSaveSubtype] = useState('')
  const [saveTags, setSaveTags] = useState('')
  const [saveContent, setSaveContent] = useState('')
  const [saving, setSaving] = useState(false)
  const titleLabel = loading
    ? 'Loading'
    : detail?.job.definition_name || detail?.job.job_type.replace(/_/g, ' ') || (error ? 'Error' : 'Untitled')

  useDocumentTitle(`Job - ${titleLabel}`)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchDetail = useCallback(async () => {
    try {
      const data = await getKdagJob(id, true)
      setDetail(data)
      setError(null)
    } catch {
      setError('Failed to load job')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    fetchDetail()
  }, [fetchDetail])

  // Initialize assistant selection from job data
  useEffect(() => {
    if (detail && !selectedAssistant) {
      setSelectedAssistant(detail.job.assistant_handle)
    }
  }, [detail, selectedAssistant])

  // Poll while any run is active
  useEffect(() => {
    if (!detail) return
    const latestRun = detail.runs[0]
    const isActive = latestRun?.status === 'running' || latestRun?.status === 'pending'

    if (isActive) {
      pollRef.current = setInterval(fetchDetail, POLL_INTERVAL)
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [detail, fetchDetail])

  const handleRetry = useCallback(async () => {
    setActionLoading(true)
    try {
      const timeoutMs = parseInt(selectedTimeout, 10)
      const modelOpt = selectedModel || undefined
      await retryKdagJob(id, {
        assistant_handle: selectedAssistant || undefined,
        model: modelOpt,
        step_timeout_ms: timeoutMs !== 120000 ? timeoutMs : undefined,
      })
      // Optimistically mark latest run as running so polling kicks in
      setDetail(prev => {
        if (!prev || !prev.runs[0]) return prev
        const updatedRuns = [...prev.runs]
        updatedRuns[0] = { ...updatedRuns[0], status: 'running', error: null }
        return {
          ...prev,
          job: { ...prev.job, assistant_handle: selectedAssistant || prev.job.assistant_handle },
          runs: updatedRuns,
        }
      })
    } catch { /* ignore */ }
    setActionLoading(false)
  }, [id, selectedAssistant, selectedModel, selectedTimeout])

  const handleRerun = useCallback(async () => {
    setActionLoading(true)
    try {
      const timeoutMs = parseInt(selectedTimeout, 10)
      const modelOpt = selectedModel || undefined
      await runKdagJob(id, {
        assistant_handle: selectedAssistant || undefined,
        model: modelOpt,
        step_timeout_ms: timeoutMs !== 120000 ? timeoutMs : undefined,
      })
      // Optimistically add a running indicator so polling kicks in
      setDetail(prev => {
        if (!prev) return prev
        return {
          ...prev,
          job: { ...prev.job, assistant_handle: selectedAssistant || prev.job.assistant_handle },
          runs: [{ id: 'optimistic', status: 'running' as const, model: modelOpt || null, exit_code: null, error: null, duration_ms: null, step_count: 0, steps_completed: 0, steps: [], output: null, started_at: new Date().toISOString(), completed_at: null, created_at: new Date().toISOString() }, ...prev.runs],
        }
      })
    } catch { /* ignore */ }
    setActionLoading(false)
  }, [id, selectedAssistant, selectedModel, selectedTimeout])

  const handleRerunFromStep = useCallback(async (stepKey: string, fromBatch?: number) => {
    setActionLoading(true)
    try {
      const timeoutMs = parseInt(selectedTimeout, 10)
      const modelOpt = selectedModel || undefined
      await rerunKdagJobFromStep(id, stepKey, {
        from_batch: fromBatch,
        model: modelOpt,
        step_timeout_ms: timeoutMs !== 120000 ? timeoutMs : undefined,
      })
      setDetail(prev => {
        if (!prev) return prev
        return {
          ...prev,
          runs: [{ id: 'optimistic', status: 'running' as const, model: modelOpt || null, exit_code: null, error: null, duration_ms: null, step_count: 0, steps_completed: 0, steps: [], output: null, started_at: new Date().toISOString(), completed_at: null, created_at: new Date().toISOString() }, ...prev.runs],
        }
      })
      setSelectedRunIndex(0)
    } catch { /* ignore */ }
    setActionLoading(false)
  }, [id, selectedModel, selectedTimeout])

  const handleCancel = useCallback(async () => {
    setActionLoading(true)
    try {
      await cancelKdagJob(id)
      await fetchDetail()
    } catch { /* ignore */ }
    setActionLoading(false)
  }, [id, fetchDetail])

  const handleDelete = useCallback(async () => {
    try {
      await deleteKdagJob(id)
      setLocation('/kdag/jobs')
    } catch {
      setError('Failed to delete job')
    } finally {
      setShowDeleteConfirm(false)
    }
  }, [id, setLocation])

  const togglePanel = useCallback((key: string) => {
    setExpandedPanels((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleInputContent = useCallback((inputId: string) => {
    setExpandedInputs((prev) => {
      const next = new Set(prev)
      if (next.has(inputId)) next.delete(inputId)
      else next.add(inputId)
      return next
    })
  }, [])

  const [copiedRaw, setCopiedRaw] = useState(false)
  const [copiedMarkdown, setCopiedMarkdown] = useState(false)
  const [copiedSlack, setCopiedSlack] = useState(false)

  const copyText = useCallback((text: string) => {
    navigator.clipboard.writeText(text)
    showToast('Copied to clipboard')
  }, [showToast])

  const copyRaw = useCallback((text: string) => {
    navigator.clipboard.writeText(text)
    setCopiedRaw(true)
    setTimeout(() => setCopiedRaw(false), 2000)
    showToast('Copied to clipboard')
  }, [showToast])

  const copyAsMarkdown = useCallback((text: string, stepSlug?: string) => {
    if (!detail) return
    const { job } = detail
    const lines = [
      '---',
      `job_id: ${job.id}`,
      `definition: ${job.definition_name || job.job_type}`,
    ]
    if (job.project_name) lines.push(`project: ${job.project_name}`)
    if (stepSlug) lines.push(`step: ${stepSlug}`)
    lines.push(`date: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`)
    lines.push('---', '', text)
    const md = lines.join('\n')
    navigator.clipboard.writeText(md)
    setCopiedMarkdown(true)
    setTimeout(() => setCopiedMarkdown(false), 2000)
    showToast('Copied as Markdown')
  }, [detail, showToast])

  const copyAsSlack = useCallback((text: string, label?: string) => {
    if (!detail) return
    const { job } = detail
    const title = label || job.definition_name || job.job_type.replace(/_/g, ' ')
    const slack = `*${title}*\n\`\`\`\n${text}\n\`\`\``
    navigator.clipboard.writeText(slack)
    setCopiedSlack(true)
    setTimeout(() => setCopiedSlack(false), 2000)
    showToast('Copied for Slack')
  }, [detail, showToast])

  const tryParseJson = useCallback((text: string): object | null => {
    const trimmed = text.trimStart()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
    try { return JSON.parse(trimmed) } catch { return null }
  }, [])

  const [copiedYaml, setCopiedYaml] = useState(false)

  const copyAsYaml = useCallback((text: string) => {
    const parsed = tryParseJson(text)
    if (!parsed) return
    const yamlStr = yaml.dump(parsed, { lineWidth: 120, noRefs: true })
    navigator.clipboard.writeText(yamlStr)
    setCopiedYaml(true)
    setTimeout(() => setCopiedYaml(false), 2000)
    showToast('Copied as YAML')
  }, [tryParseJson, showToast])

  const downloadYaml = useCallback((text: string, baseName: string) => {
    const parsed = tryParseJson(text)
    if (!parsed) return
    const yamlStr = yaml.dump(parsed, { lineWidth: 120, noRefs: true })
    const blob = new Blob([yamlStr], { type: 'text/yaml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${toKebab(baseName)}.yaml`
    a.click()
    URL.revokeObjectURL(url)
  }, [tryParseJson])

  const toKebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  const downloadText = useCallback((text: string, baseName: string) => {
    const trimmed = text.trimStart()
    let ext = 'md'
    let mime = 'text/markdown'
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { JSON.parse(trimmed); ext = 'json'; mime = 'application/json' } catch {}
    } else {
      const result = Papa.parse(trimmed, { header: true, preview: 5 })
      if (!result.errors.length && result.meta.fields && result.meta.fields.length >= 2 && result.data.length >= 1) {
        ext = 'csv'; mime = 'text/csv'
      }
    }
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${toKebab(baseName)}.${ext}`
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  const openSaveModal = async (content: string) => {
    if (!detail) return
    setSaveContent(content)
    const { job } = detail
    const title = job.definition_name || job.job_type.replace(/_/g, ' ')
    setSaveTitle(title)
    setSaveHandle('')
    setSaveType('project-note')
    setSaveSubtype('')
    setSaveTags('')
    setShowSaveModal(true)

    const promises: Promise<any>[] = []
    if (saveProjects.length === 0) {
      promises.push(getProjects().then(list => {
        const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name))
        setSaveProjects(sorted)
        const match = job.project_handle
          ? sorted.find(p => p.handle === job.project_handle)
          : sorted.find(p => p.handle === 'user')
        setSaveProjectId(match?.id || sorted[0]?.id || '')
      }))
    } else {
      const match = job.project_handle
        ? saveProjects.find(p => p.handle === job.project_handle)
        : saveProjects.find(p => p.handle === 'user')
      setSaveProjectId(match?.id || saveProjects[0]?.id || '')
    }
    if (saveMemoryTypes.length === 0) {
      promises.push(getMemoryTypes().then(types => {
        setSaveMemoryTypes(types)
        const { hierarchy } = buildTypeHierarchy(types)
        setSaveTypeHierarchy(hierarchy)
      }))
    }
    await Promise.all(promises).catch(() => {})
  }

  const handleSaveAsMemory = async () => {
    if (!saveContent || !saveTitle.trim() || !saveProjectId) return
    setSaving(true)
    try {
      const handle = saveHandle.trim() || saveTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      const tags = saveTags.split(',').map(t => t.trim()).filter(Boolean)
      const effectiveType = saveSubtype || saveType
      const memory = await createMemory(saveProjectId, {
        handle,
        title: saveTitle.trim(),
        content: saveContent,
        type: effectiveType as any,
        tags: tags.length > 0 ? tags : undefined,
      })
      showToast('Saved as memory', {
        label: 'View',
        onClick: () => setLocation(`/memories/${memory.id}`),
      }, { persistent: true })
      setShowSaveModal(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const renderStepCard = (step: KdagJobStep, allSteps: KdagJobStep[], runStatus?: string) => {
    const inputKey = `in:${step.id}`
    const outputKey = `out:${step.id}`
    const inputOpen = expandedPanels.has(inputKey)
    const outputOpen = expandedPanels.has(outputKey)
    const hasInput = !!step.input_text
    const hasOutput = !!step.output_preview
    const isBatch = step.step_type === 'batch_summary'
    const canRerunFrom = runStatus === 'completed' && step.definition_step_key && step.step_type !== 'synthesis' && !actionLoading
    return (
      <div key={step.id} class={styles.stepCard}>
        <div class={styles.stepHeader}>
          <span class={styles.stepLabel}>{stepLabel(step, allSteps)}</span>
          <span class={clsx(styles.statusBadge, statusClass(step.status))}>
            {step.status === 'running' && <Loader size={10} class={styles.spinning} />}
            {step.status}
          </span>
          {step.metadata?.backend && (
            <span class={styles.stepMetaTag}>{step.metadata.backend}</span>
          )}
          {step.metadata?.model && (
            <span class={styles.stepMetaTag}>{step.metadata.model}</span>
          )}
          {step.metadata?.timeout_ms != null && (
            <span class={styles.stepMetaTag}>{formatDuration(step.metadata.timeout_ms)} timeout</span>
          )}
          {step.metadata?.allowed_tools && (
            <span class={styles.stepMetaTag} title={step.metadata.allowed_tools.join(', ')}>
              {step.metadata.allowed_tools.length} tools
            </span>
          )}
          <span class={styles.stepMeta}>{formatDuration(step.duration_ms)}</span>
          {canRerunFrom && (
            <button
              class={styles.stepRerunBtn}
              onClick={() => handleRerunFromStep(step.definition_step_key!, isBatch ? step.step_index : undefined)}
              title={isBatch ? `Rerun from batch ${step.step_index + 1}` : `Rerun from "${step.definition_step_name || step.definition_step_key}"`}
            >
              <FastForward size={12} /> Rerun from here
            </button>
          )}
          <span class={styles.stepToggles}>
            {hasInput && (
              <button
                class={clsx(styles.stepToggle, inputOpen && styles.stepToggleActive)}
                onClick={() => togglePanel(inputKey)}
              >
                Input{step.input_chars != null ? ` (${formatChars(step.input_chars)})` : ''}
              </button>
            )}
            {!hasInput && step.input_chars != null && (
              <span class={styles.stepMeta}>{formatChars(step.input_chars)} in</span>
            )}
            {hasOutput && (
              <button
                class={clsx(styles.stepToggle, outputOpen && styles.stepToggleActive)}
                onClick={() => togglePanel(outputKey)}
              >
                Output{step.output_length != null ? ` (${formatChars(step.output_length)})` : ''}
              </button>
            )}
            {step.metadata?.command && (
              <button
                class={clsx(styles.stepToggle, expandedPanels.has(`${step.id}-cmd`) && styles.stepToggleActive)}
                onClick={() => togglePanel(`${step.id}-cmd`)}
              >
                Command
              </button>
            )}
          </span>
        </div>
        {expandedPanels.has(`${step.id}-cmd`) && step.metadata?.command && (
          <div class={styles.stepCommand}>
            <code>{step.metadata.command}</code>
          </div>
        )}
        {inputOpen && step.input_text && (
          <div class={styles.stepOutputWrap}>
            <div class={styles.stepOutputActions}>
              <div class={styles.stepExportMenuContainer}>
                <button class={styles.stepActionBtn} onClick={() => copyText(step.input_text!)}>
                  <Copy size={12} /> Copy
                </button>
                <div class={styles.stepExportMenuOptions}>
                  <button class={styles.stepExportOption} onClick={() => copyAsMarkdown(step.input_text!, `${stepFileSlug(step)}-input`)}>
                    <FileText size={10} /> Markdown
                  </button>
                  {tryParseJson(step.input_text!) && (
                    <button class={styles.stepExportOption} onClick={() => copyAsYaml(step.input_text!)}>
                      <FileText size={10} /> YAML
                    </button>
                  )}
                  <button class={styles.stepExportOption} onClick={() => copyAsSlack(step.input_text!, `${stepLabel(step, allSteps)} Input`)}>
                    <MessageSquareText size={10} /> Slack
                  </button>
                </div>
              </div>
              <div class={styles.stepExportMenuContainer}>
                <button class={styles.stepActionBtn} onClick={() => downloadText(step.input_text!, `${detail?.job.definition_name || 'job'}-${stepFileSlug(step)}-input`)}>
                  <Download size={12} /> Export
                </button>
                <div class={styles.stepExportMenuOptions}>
                  {tryParseJson(step.input_text!) && (
                    <button class={styles.stepExportOption} onClick={() => downloadYaml(step.input_text!, `${detail?.job.definition_name || 'job'}-${stepFileSlug(step)}-input`)}>
                      <Download size={10} /> YAML
                    </button>
                  )}
                  <button class={styles.stepExportOption} onClick={() => openSaveModal(step.input_text!)}>
                    <Save size={10} /> Save as Memory
                  </button>
                </div>
              </div>
            </div>
            <pre class={styles.stepContentPanel}>{step.input_text}</pre>
          </div>
        )}
        {outputOpen && step.output_preview && (
          <div class={styles.stepOutputWrap}>
            <div class={styles.stepOutputActions}>
              <div class={styles.stepExportMenuContainer}>
                <button class={styles.stepActionBtn} onClick={() => copyText(step.output_preview!)}>
                  <Copy size={12} /> Copy
                </button>
                <div class={styles.stepExportMenuOptions}>
                  <button class={styles.stepExportOption} onClick={() => copyAsMarkdown(step.output_preview!, `${stepFileSlug(step)}-output`)}>
                    <FileText size={10} /> Markdown
                  </button>
                  {tryParseJson(step.output_preview!) && (
                    <button class={styles.stepExportOption} onClick={() => copyAsYaml(step.output_preview!)}>
                      <FileText size={10} /> YAML
                    </button>
                  )}
                  <button class={styles.stepExportOption} onClick={() => copyAsSlack(step.output_preview!, `${stepLabel(step, allSteps)} Output`)}>
                    <MessageSquareText size={10} /> Slack
                  </button>
                </div>
              </div>
              <div class={styles.stepExportMenuContainer}>
                <button class={styles.stepActionBtn} onClick={() => downloadText(step.output_preview!, `${detail?.job.definition_name || 'job'}-${stepFileSlug(step)}-output`)}>
                  <Download size={12} /> Export
                </button>
                <div class={styles.stepExportMenuOptions}>
                  {tryParseJson(step.output_preview!) && (
                    <button class={styles.stepExportOption} onClick={() => downloadYaml(step.output_preview!, `${detail?.job.definition_name || 'job'}-${stepFileSlug(step)}-output`)}>
                      <Download size={10} /> YAML
                    </button>
                  )}
                  <button class={styles.stepExportOption} onClick={() => openSaveModal(step.output_preview!)}>
                    <Save size={10} /> Save as Memory
                  </button>
                </div>
              </div>
            </div>
            <pre class={styles.stepContentPanel}>{step.output_preview}</pre>
          </div>
        )}
      </div>
    )
  }

  if (loading) {
    return (
      <div class={styles.page}>
        <div class={styles.loading}><Loader size={16} class={styles.spinning} /> Loading job...</div>
      </div>
    )
  }

  if (error && !detail) {
    return (
      <div class={styles.page}>
        <PageHeader
          title="Error"
          breadcrumbs={[{ label: 'Kdag', href: '/kdag' }, { label: 'Jobs', href: '/kdag/jobs' }]}
        />
        <div class={styles.error}>{error}</div>
      </div>
    )
  }

  if (!detail) return null

  const { job, inputs, runs } = detail
  const latestRun = runs[0]
  const selectedRun = runs[selectedRunIndex]
  const isRunning = latestRun?.status === 'running' || latestRun?.status === 'pending'
  const isFailed = latestRun?.status === 'failed'

  return (
    <div class={styles.page}>
      {/* Header */}
      <PageHeader
        title={detail.job.definition_name || detail.job.job_type}
        breadcrumbs={[{ label: 'Kdag', href: '/kdag' }, { label: 'Jobs', href: '/kdag/jobs' }]}
      />
      <div class={styles.header}>
        <div class={styles.headerTop}>
          <div class={styles.headerInfo}>
            <h1 class={styles.title}>
              {job.definition_key ? (
                <a
                  href={`/kdag/definitions/${job.definition_key}`}
                  class={styles.definitionLink}
                  onClick={(e) => { e.preventDefault(); setLocation(`/kdag/definitions/${job.definition_key}`) }}
                >
                  {job.definition_name || job.job_type.replace(/_/g, ' ')}
                </a>
              ) : (
                job.definition_name || job.job_type.replace(/_/g, ' ')
              )}
              {latestRun && (
                <span class={clsx(styles.statusBadge, statusClass(latestRun.status))}>
                  {isRunning && <Loader size={10} class={styles.spinning} />}
                  {latestRun.status}
                </span>
              )}
            </h1>
            <div class={styles.meta}>
              <CopyButton text={job.id} title="Copy job ID" size={12} />
              {job.project_name && (
                <span class={styles.runMetaItem}>
                  <span class={styles.metaLabel}>Project:</span>
                  {job.project_id ? (
                    <a
                      href={`/projects/${job.project_id}`}
                      class={styles.projectLink}
                      onClick={(e) => { e.preventDefault(); setLocation(`/projects/${job.project_id}`) }}
                    >
                      {job.project_name}
                    </a>
                  ) : (
                    <span class={styles.metaValue}>{job.project_name}</span>
                  )}
                </span>
              )}
              <span class={styles.runMetaItem}>
                <span class={styles.metaLabel}>Assistant:</span>
                <span class={styles.assistantBadge}>{job.assistant_handle}</span>
              </span>
              {latestRun?.duration_ms != null && (
                <span class={styles.runMetaItem}>
                  <span class={styles.metaLabel}>Duration:</span>
                  <span class={styles.duration}>{formatDuration(latestRun.duration_ms)}</span>
                </span>
              )}
              <span class={styles.timestamp}>{formatRelativeTime(job.created_at)}</span>
            </div>
          </div>

          <div class={styles.actions}>
            {!isRunning && (
              <>
                <select
                  class={styles.assistantSelect}
                  value={selectedAssistant}
                  onChange={(e) => {
                    setSelectedAssistant((e.target as HTMLSelectElement).value)
                    setSelectedModel('')
                  }}
                >
                  {availableBackends.map(b => (
                    <option key={b.key} value={b.key}>{b.name}</option>
                  ))}
                </select>
                <ModelCombobox
                  value={selectedModel}
                  onChange={setSelectedModel}
                  models={selectedBackend?.models || []}
                />
                <select
                  class={styles.assistantSelect}
                  value={selectedTimeout}
                  onChange={(e) => setSelectedTimeout((e.target as HTMLSelectElement).value)}
                  title="Timeout per step"
                >
                  <option value="120000">2 min/step</option>
                  <option value="300000">5 min/step</option>
                  <option value="600000">10 min/step</option>
                  <option value="900000">15 min/step</option>
                  <option value="1200000">20 min/step</option>
                  <option value="1800000">30 min/step</option>
                </select>
                {isFailed && (
                  <button
                    class={styles.actionBtn}
                    disabled={actionLoading}
                    onClick={handleRetry}
                  >
                    <RotateCcw size={14} /> Retry
                  </button>
                )}
                <button
                  class={styles.actionBtn}
                  disabled={actionLoading}
                  onClick={handleRerun}
                >
                  <Play size={14} /> {runs.length > 0 ? 'Rerun' : 'Run'}
                </button>
              </>
            )}
            {isRunning && (
              <button
                class={clsx(styles.actionBtn, styles.actionBtnDanger)}
                disabled={actionLoading}
                onClick={handleCancel}
              >
                <XCircle size={14} /> Cancel
              </button>
            )}
            {!isRunning && (
              <button
                class={clsx(styles.actionBtn, styles.actionBtnDanger)}
                disabled={actionLoading}
                onClick={() => setShowDeleteConfirm(true)}
              >
                <Trash2 size={14} /> Delete
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Progress bar for running jobs with steps */}
      {latestRun && latestRun.step_count > 0 && (
        <div class={styles.progressBar}>
          <div class={styles.progressTrack}>
            <div
              class={clsx(
                styles.progressFill,
                latestRun.status === 'completed' && styles.progressFillComplete,
                latestRun.status === 'failed' && styles.progressFillFailed,
              )}
              style={{ width: `${(latestRun.steps_completed / latestRun.step_count) * 100}%` }}
            />
          </div>
          <span class={styles.progressLabel}>
            {latestRun.steps_completed}/{latestRun.step_count} steps
          </span>
        </div>
      )}

      {error && <div class={styles.error}>{error}</div>}

      {/* Inputs */}
      <div class={styles.section}>
        <h2 class={styles.sectionTitle}>Inputs</h2>
        <div class={styles.inputsList}>
          {inputs.map((input) => {
            const isOpen = expandedInputs.has(input.id)
            const hasContent = !!input.content
            return (
              <div key={input.id} class={styles.inputItemWrap}>
                <div
                  class={clsx(styles.inputItem, hasContent && styles.inputItemClickable)}
                  onClick={hasContent ? () => toggleInputContent(input.id) : undefined}
                >
                  {hasContent && (
                    <ChevronRight
                      size={12}
                      class={clsx(styles.expandArrow, isOpen && styles.expandArrowOpen)}
                    />
                  )}
                  <span class={styles.inputType}>{input.input_type}</span>
                  <span class={styles.inputSize}>{formatBytes(input.content_length)}</span>
                  {input.ref_type && (
                    <span class={styles.inputRef}>
                      {input.ref_type}:{input.ref_id?.slice(0, 8)}
                    </span>
                  )}
                </div>
                {isOpen && input.content && (
                  <div class={styles.stepOutputWrap}>
                    <div class={styles.stepOutputActions}>
                      <div class={styles.stepExportMenuContainer}>
                        <button class={styles.stepActionBtn} onClick={(e) => { e.stopPropagation(); copyText(input.content!) }}>
                          <Copy size={12} /> Copy
                        </button>
                        <div class={styles.stepExportMenuOptions}>
                          <button class={styles.stepExportOption} onClick={(e) => { e.stopPropagation(); copyAsMarkdown(input.content!, `input-${input.input_type}`) }}>
                            <FileText size={10} /> Markdown
                          </button>
                          {tryParseJson(input.content!) && (
                            <button class={styles.stepExportOption} onClick={(e) => { e.stopPropagation(); copyAsYaml(input.content!) }}>
                              <FileText size={10} /> YAML
                            </button>
                          )}
                          <button class={styles.stepExportOption} onClick={(e) => { e.stopPropagation(); copyAsSlack(input.content!, `${input.input_type} Input`) }}>
                            <MessageSquareText size={10} /> Slack
                          </button>
                        </div>
                      </div>
                      <div class={styles.stepExportMenuContainer}>
                        <button class={styles.stepActionBtn} onClick={(e) => { e.stopPropagation(); downloadText(input.content!, `${detail?.job.definition_name || 'job'}-input-${input.input_type}`) }}>
                          <Download size={12} /> Export
                        </button>
                        <div class={styles.stepExportMenuOptions}>
                          {tryParseJson(input.content!) && (
                            <button class={styles.stepExportOption} onClick={(e) => { e.stopPropagation(); downloadYaml(input.content!, `${detail?.job.definition_name || 'job'}-input-${input.input_type}`) }}>
                              <Download size={10} /> YAML
                            </button>
                          )}
                          <button class={styles.stepExportOption} onClick={(e) => { e.stopPropagation(); openSaveModal(input.content!) }}>
                            <Save size={10} /> Save as Memory
                          </button>
                        </div>
                      </div>
                    </div>
                    <pre class={styles.inputContent}>{input.content}</pre>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Runs */}
      <div class={styles.section}>
        <div class={styles.sectionHeader}>
          <h2 class={styles.sectionTitle}>Run</h2>
          {runs.length > 1 && (
            <select
              class={styles.runSelect}
              value={selectedRunIndex}
              onChange={(e) => setSelectedRunIndex(parseInt((e.target as HTMLSelectElement).value, 10))}
            >
              {runs.map((run, i) => (
                <option key={run.id} value={i}>
                  {run.id.slice(0, 8)} — {run.status}{run.duration_ms != null ? ` (${formatDuration(run.duration_ms)})` : ''}{i === 0 ? ' (latest)' : ''}
                </option>
              ))}
            </select>
          )}
        </div>
        {(() => {
          const run = runs[selectedRunIndex]
          if (!run) return null
          return (
            <div class={styles.runCard}>
              <div class={styles.runHeader}>
                <span class={clsx(styles.statusBadge, statusClass(run.status))}>
                  {run.status === 'running' && <Loader size={10} class={styles.spinning} />}
                  {run.status}
                </span>
                <span class={styles.runId}>{run.id.slice(0, 8)}</span>
              </div>

              <div class={styles.runMeta}>
                {run.model && (
                  <div class={styles.runMetaItem}>
                    <span class={styles.runMetaLabel}>Model:</span>
                    <span class={styles.runMetaValue}>{run.model}</span>
                  </div>
                )}
                <div class={styles.runMetaItem}>
                  <span class={styles.runMetaLabel}>Duration:</span>
                  <span class={styles.runMetaValue}>{formatDuration(run.duration_ms)}</span>
                </div>
                {run.exit_code != null && (
                  <div class={styles.runMetaItem}>
                    <span class={styles.runMetaLabel}>Exit:</span>
                    <span class={styles.runMetaValue}>{run.exit_code}</span>
                  </div>
                )}
                {run.started_at && (
                  <div class={styles.runMetaItem}>
                    <span class={styles.runMetaLabel}>Started:</span>
                    <span class={styles.runMetaValue}>{formatRelativeTime(run.started_at)}</span>
                  </div>
                )}
              </div>

              {run.error && <div class={styles.runError}>{run.error}</div>}

              {/* Steps */}
              {run.steps.length > 0 && (
                <div class={styles.stepsList}>
                  {(() => {
                    // Group batch_summary steps by definition_step_index for collapsible rendering
                    const rendered = new Set<string>()
                    return run.steps.map((step: KdagJobStep) => {
                      if (step.step_type === 'batch_summary') {
                        const groupKey = `batch-group-${step.definition_step_index}`
                        if (rendered.has(groupKey)) return null
                        rendered.add(groupKey)

                        const batchSteps = run.steps.filter(
                          s => s.step_type === 'batch_summary' && s.definition_step_index === step.definition_step_index
                        )
                        const completedCount = batchSteps.filter(s => s.status === 'completed').length
                        const failedCount = batchSteps.filter(s => s.status === 'failed').length
                        const runningCount = batchSteps.filter(s => s.status === 'running').length
                        const totalDuration = batchSteps.reduce((sum, s) => sum + (s.duration_ms || 0), 0)
                        const isExpanded = expandedBatchGroups.has(groupKey)

                        const toggleGroup = () => {
                          setExpandedBatchGroups(prev => {
                            const next = new Set(prev)
                            if (next.has(groupKey)) next.delete(groupKey)
                            else next.add(groupKey)
                            return next
                          })
                        }

                        const batchDefKey = step.definition_step_key
                        const canRerunBatch = run.status === 'completed' && batchDefKey && !actionLoading

                        return (
                          <div key={groupKey} class={styles.batchGroup}>
                            <div class={styles.batchGroupRow}>
                              <button class={styles.batchGroupHeader} onClick={toggleGroup}>
                                {isExpanded
                                  ? <ChevronDown size={14} class={styles.batchGroupChevron} />
                                  : <ChevronRight size={14} class={styles.batchGroupChevron} />
                                }
                                <span class={styles.stepLabel}>Batches</span>
                                <span class={clsx(styles.statusBadge, failedCount > 0 ? statusClass('failed') : runningCount > 0 ? statusClass('running') : statusClass('completed'))}>
                                  {runningCount > 0 && <Loader size={10} class={styles.spinning} />}
                                  {completedCount}/{batchSteps.length} completed
                                  {failedCount > 0 && `, ${failedCount} failed`}
                                </span>
                                <span class={styles.stepMeta}>{formatDuration(totalDuration)}</span>
                              </button>
                              {canRerunBatch && (
                                <button
                                  class={styles.stepRerunBtn}
                                  onClick={() => handleRerunFromStep(batchDefKey!)}
                                  title={`Rerun from "${step.definition_step_name || batchDefKey}"`}
                                >
                                  <FastForward size={12} /> Rerun from here
                                </button>
                              )}
                            </div>
                            {isExpanded && (
                              <div class={styles.batchGroupBody}>
                                {batchSteps.map(bs => renderStepCard(bs, run.steps, run.status))}
                              </div>
                            )}
                          </div>
                        )
                      }

                      return renderStepCard(step, run.steps, run.status)
                    })
                  })()}
                </div>
              )}
            </div>
          )
        })()}
      </div>

      {/* Output */}
      {selectedRun?.output && (
        <div class={styles.section}>
          <div class={styles.sectionHeader}>
            <h2 class={styles.sectionTitle}>Output</h2>
            <div class={styles.actionBtns}>
              <div class={styles.exportMenuContainer}>
                <button class={styles.actionBtn} onClick={() => copyRaw(selectedRun.output!)}>
                  {copiedRaw ? <Check size={14} /> : <Copy size={14} />}
                  {copiedRaw ? 'Copied' : 'Copy'}
                </button>
                <div class={styles.exportMenuOptions}>
                  <button class={styles.exportOption} onClick={() => copyAsMarkdown(selectedRun.output!)}>
                    {copiedMarkdown ? <Check size={14} /> : <FileText size={14} />}
                    {copiedMarkdown ? 'Copied' : 'Markdown'}
                  </button>
                  {tryParseJson(selectedRun.output!) && (
                    <button class={styles.exportOption} onClick={() => copyAsYaml(selectedRun.output!)}>
                      {copiedYaml ? <Check size={14} /> : <FileText size={14} />}
                      {copiedYaml ? 'Copied' : 'YAML'}
                    </button>
                  )}
                  <button class={styles.exportOption} onClick={() => copyAsSlack(selectedRun.output!)}>
                    {copiedSlack ? <Check size={14} /> : <MessageSquareText size={14} />}
                    {copiedSlack ? 'Copied' : 'Slack'}
                  </button>
                </div>
              </div>
              <div class={styles.exportMenuContainer}>
                <button class={styles.actionBtn} onClick={() => downloadText(selectedRun.output!, `${detail?.job.definition_name || 'job'}-output`)}>
                  <Download size={14} /> Export
                </button>
                <div class={styles.exportMenuOptions}>
                  {tryParseJson(selectedRun.output!) && (
                    <button class={styles.exportOption} onClick={() => downloadYaml(selectedRun.output!, `${detail?.job.definition_name || 'job'}-output`)}>
                      <Download size={14} /> YAML
                    </button>
                  )}
                  <button class={styles.exportOption} onClick={() => openSaveModal(selectedRun.output!)}>
                    <Save size={14} /> Save as Memory
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div class={styles.outputPanel}>
            <pre>{selectedRun.output}</pre>
          </div>
        </div>
      )}

      {showDeleteConfirm && (
        <ConfirmModal
          title="Delete job"
          message={`Delete this ${job.job_type} job? This will remove all runs, inputs, and outputs.`}
          confirmLabel="Delete"
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {showSaveModal && (
        <div class={styles.modalOverlay} onClick={() => setShowSaveModal(false)}>
          <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div class={styles.modalHeader}>
              <h3 class={styles.modalTitle}>Save as Memory</h3>
              <button
                type="button"
                class={styles.modalClose}
                onClick={() => setShowSaveModal(false)}
              >
                <X size={20} />
              </button>
            </div>
            <div class={styles.modalBody}>
              <div class={styles.formRow}>
                <label class={styles.formLabel}>Project</label>
                <select
                  class={styles.formSelect}
                  value={saveProjectId}
                  onChange={(e) => setSaveProjectId((e.target as HTMLSelectElement).value)}
                >
                  {saveProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div class={styles.formRow}>
                <label class={styles.formLabel}>Title</label>
                <input
                  type="text"
                  class={styles.formInput}
                  value={saveTitle}
                  onInput={(e) => setSaveTitle((e.target as HTMLInputElement).value)}
                  placeholder="Memory title"
                  autoFocus
                />
              </div>
              <div class={styles.formRow}>
                <label class={styles.formLabel}>Handle</label>
                <input
                  type="text"
                  class={styles.formInput}
                  value={saveHandle}
                  onInput={(e) => setSaveHandle((e.target as HTMLInputElement).value)}
                  placeholder="Optional (auto-generated)"
                />
              </div>
              <div class={styles.formRow}>
                <label class={styles.formLabel}>Type</label>
                <select
                  class={styles.formSelect}
                  value={saveType}
                  onChange={(e) => {
                    const nextType = (e.target as HTMLSelectElement).value
                    setSaveType(nextType)
                    const children = saveTypeHierarchy[nextType]
                    setSaveSubtype(children && children.length > 0 ? children[0] : '')
                  }}
                >
                  {(() => {
                    const { childTypes } = buildTypeHierarchy(saveMemoryTypes)
                    const topLevel = saveMemoryTypes.filter(t => !childTypes.has(t.type))
                    return topLevel.map((t) => (
                      <option key={t.type} value={t.type}>
                        {getTypeLabel(t.type)}{saveTypeHierarchy[t.type] ? ' \u25B8' : ''}
                      </option>
                    ))
                  })()}
                </select>
              </div>
              {(saveTypeHierarchy[saveType]?.length ?? 0) > 0 && (
                <div class={styles.formRow}>
                  <label class={styles.formLabel}>Subtype</label>
                  <select
                    class={styles.formSelect}
                    value={saveSubtype}
                    onChange={(e) => setSaveSubtype((e.target as HTMLSelectElement).value)}
                  >
                    {saveTypeHierarchy[saveType]?.map((t) => (
                      <option key={t} value={t}>
                        {getTypeLabel(t)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div class={styles.formRow}>
                <label class={styles.formLabel}>Content</label>
                <div class={styles.previewContent}>
                  {saveContent.slice(0, 300)}
                  {saveContent.length > 300 && '...'}
                </div>
              </div>
              <div class={styles.formRow}>
                <label class={styles.formLabel}>Tags</label>
                <input
                  type="text"
                  class={styles.formInput}
                  value={saveTags}
                  onInput={(e) => setSaveTags((e.target as HTMLInputElement).value)}
                  placeholder="Add tags (comma separated)"
                />
              </div>
              <div class={styles.formActions}>
                <button
                  type="button"
                  class={styles.cancelButton}
                  onClick={() => setShowSaveModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class={styles.saveButton}
                  onClick={handleSaveAsMemory}
                  disabled={!saveTitle.trim() || !saveProjectId || saving}
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
