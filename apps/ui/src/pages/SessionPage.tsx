import { useState, useEffect, useMemo, useRef, useCallback } from 'preact/hooks'
import { Link, useLocation } from 'wouter-preact'
import { Clock, FileText, User, Bot, X, ChevronLeft, ChevronRight, Sparkles, ChevronDown, ChevronUp, Loader, RefreshCw, AlertTriangle, Pencil, Check, Copy, MessageSquareText, Code, Square, Play, Trash2 } from 'lucide-preact'
import { getSession, getActiveSessions, terminateActiveSession, getSessionSummary, getSessionSummarySnapshot, createKdagJob, runKdagJob, retryKdagJob, getKdagJob, updateSessionSummary, exportSessionSummary, deleteSessionSummarySnapshot, deleteSessionSummary, patchSession, bulkDeleteSessions, sendLiveMessage, triggerSessionSync, getSessionRaw, getSessionLineageTokenCount, getSessionLiveMemory, type SessionLineageTokenCount, type SessionLiveMemory } from '../lib/api'
import { CodeEditor } from '../components/editor/CodeEditor'
import { renderMarkdown } from '../lib/markdown'
import { normalizeRawEntries } from '../lib/sessionRawNormalize'
import {
  getSessionNavContext,
  updateSessionNavIndex,
  getPrevSessionId,
  getNextSessionId,
  getSessionPositionInfo,
} from '../lib/sessionNavContext'
import { loadSession, saveSession } from '../lib/store'
import { AssistantBadge, CopyButton, ConfirmModal, ModelCombobox, useToast, LoadingMessage, VirtualList } from '../components/ui'
import { useDocumentTitle } from '../hooks'
import { ArchiveBadge, ChatInput, SessionTerminal, SessionToolbar } from '../components/session'
import type { ViewMode, SortOrder } from '../components/session'
import { useKdagBackends } from '../hooks/useKdagBackends'
import { useLiveUpdates } from '../hooks/useLiveUpdates'
import { SessionContextMenu } from '../components/shared/SessionContextMenu'
import clsx from 'clsx'
import type { SessionDetail, SessionChunk, SessionSummaryResponse, KdagJobStatus, SessionEntry, SessionContentBlock } from '../types'
import styles from './SessionPage.module.css'

interface SessionPageProps {
  id: string
  projectId?: string
}

type SegmentRole = 'user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result'

interface ParsedSegment {
  role: SegmentRole
  content: string
  chunkId: string
  toolName?: string
}

const TOOL_MARKER_RE = /^\[Tool: ([^\]]+)\] ?(.*)$/
const TOOL_RESULT_MARKER_RE = /^\[Tool Result: ([^\]]+)\] ?(.*)$/

// Parse chunk content into segments by role. Recognizes User:/Assistant: prefixes,
// [Thinking] blocks within assistant turns, and [Tool: <name>] markers (either on
// their own line or immediately following Assistant:).
function parseChunkContent(content: string, chunkId: string): ParsedSegment[] {
  const segments: ParsedSegment[] = []
  const lines = content.split('\n')
  let currentRole: SegmentRole | null = null
  let currentContent: string[] = []
  let currentToolName: string | undefined

  const flush = () => {
    if (currentRole && currentContent.length > 0) {
      const seg: ParsedSegment = { role: currentRole, content: currentContent.join('\n'), chunkId }
      if ((currentRole === 'tool_use' || currentRole === 'tool_result') && currentToolName) seg.toolName = currentToolName
      segments.push(seg)
    }
    currentContent = []
    currentToolName = undefined
  }

  for (const line of lines) {
    // Standalone tool marker line (tool_use emitted after an earlier text block)
    const toolMatch = line.match(TOOL_MARKER_RE)
    if (toolMatch) {
      flush()
      currentRole = 'tool_use'
      currentToolName = toolMatch[1]
      currentContent = [toolMatch[2]]
      continue
    }
    const toolResultMatch = line.match(TOOL_RESULT_MARKER_RE)
    if (toolResultMatch) {
      flush()
      currentRole = 'tool_result'
      currentToolName = toolResultMatch[1]
      currentContent = [toolResultMatch[2]]
      continue
    }
    if (line.startsWith('User: ')) {
      flush()
      const text = line.slice(6)
      const inlineToolResult = text.match(TOOL_RESULT_MARKER_RE)
      if (inlineToolResult) {
        currentRole = 'tool_result'
        currentToolName = inlineToolResult[1]
        currentContent = [inlineToolResult[2]]
      } else {
        currentRole = 'user'
        currentContent = [text]
      }
    } else if (line.startsWith('Assistant: ') || line.startsWith('A: ')) {
      flush()
      const prefix = line.startsWith('Assistant: ') ? 'Assistant: ' : 'A: '
      const text = line.slice(prefix.length)
      if (text.startsWith('[Thinking]')) {
        currentRole = 'thinking'
        currentContent = [text.slice(10).trim()]
      } else {
        // Assistant turn may start directly with a tool marker when there's no preceding text block
        const inlineTool = text.match(TOOL_MARKER_RE)
        if (inlineTool) {
          currentRole = 'tool_use'
          currentToolName = inlineTool[1]
          currentContent = [inlineTool[2]]
        } else {
          currentRole = 'assistant'
          currentContent = [text]
        }
      }
    } else if (currentRole) {
      // Continue current segment (handles multi-line Bash commands, wrapped text, etc.)
      currentContent.push(line)
    }
  }

  flush()
  return segments
}

/** Map model ID to max context window size in tokens */
function getContextWindowSize(model: string | null): number | null {
  if (!model) return null
  // Opus 4.x always has 1M context
  if (model.startsWith('claude-opus-4')) return 1_000_000
  // Sonnet/Haiku default to 200k
  if (model.startsWith('claude-sonnet-4')) return 200_000
  if (model.startsWith('claude-haiku-4')) return 200_000
  if (model.startsWith('claude-3')) return 200_000
  // Codex / GPT
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

export function SessionPage({ id, projectId }: SessionPageProps) {
  const { showToast } = useToast()
  const [, setLocation] = useLocation()
  const [session, setSession] = useState<SessionDetail | null>(null)
  const [chunks, setChunks] = useState<SessionChunk[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [isActive, setIsActive] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [isTerminating, setIsTerminating] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [lineageTokens, setLineageTokens] = useState<SessionLineageTokenCount | null>(null)
  const [liveMemory, setLiveMemory] = useState<SessionLiveMemory | null>(null)
  const [describeLoading, setDescribeLoading] = useState(false)
  const [describeJobId, setDescribeJobId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ chunkId: string; position: { x: number; y: number } } | null>(null)
  const sessionTitleLabel = session?.nickname || session?.name || session?.summary
  useDocumentTitle(sessionTitleLabel ? `Session - ${sessionTitleLabel}` : 'Session - Loading')

  // View mode: parsed chunks vs raw JSONL entries
  const [viewMode, setViewMode] = useState<ViewMode>('terminal')
  const [rawEntries, setRawEntries] = useState<SessionEntry[]>([])
  const [rawSource, setRawSource] = useState<'original' | 'backup' | undefined>(undefined)
  const [rawFilePath, setRawFilePath] = useState<string | undefined>(undefined)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawTotalCount, setRawTotalCount] = useState(0)
  const [rawLoadedAll, setRawLoadedAll] = useState(false)
  const [rawLoadingMore, setRawLoadingMore] = useState(false)
  const [rawError, setRawError] = useState<string | null>(null)
  const [toggledBlocks, setToggledBlocks] = useState<Set<string>>(new Set())
  const [allExpanded, setAllExpanded] = useState<boolean | null>(true) // null = per-block defaults; true = expand all
  const [showTools, setShowTools] = useState(true)
  const [showCommandsOnly, setShowCommandsOnly] = useState(false)
  const [showBashOnly, setShowBashOnly] = useState(false)

  // Segment type filters
  const [showUser, setShowUser] = useState(true)
  const [showAssistant, setShowAssistant] = useState(true)
  const [showThinking, setShowThinking] = useState(false)

  // Assistant and model selection for summarization
  const { backends, isLoading: backendsLoading } = useKdagBackends()
  const availableBackends = useMemo(() => backends.filter(b => b.available), [backends])
  const [selectedAssistant, setSelectedAssistant] = useState('claude-code')
  const [selectedModel, setSelectedModel] = useState('')
  const selectedBackend = useMemo(() => backends.find(b => b.key === selectedAssistant), [backends, selectedAssistant])

  // Short summary label (inline edit)
  const [editingLabel, setEditingLabel] = useState(false)
  const [labelDraft, setLabelDraft] = useState('')
  const labelInputRef = useRef<HTMLInputElement>(null)

  const handleLabelEdit = useCallback(() => {
    setLabelDraft(session?.summary || '')
    setEditingLabel(true)
    setTimeout(() => labelInputRef.current?.focus(), 0)
  }, [session])

  const handleLabelSave = useCallback(async () => {
    if (!session) return
    const trimmed = labelDraft.trim()
    try {
      await patchSession(session.id, { summary: trimmed || undefined })
      setSession(prev => prev ? { ...prev, summary: trimmed || null } : prev)
      showToast('Summary updated')
    } catch {
      showToast('Failed to update summary')
    }
    setEditingLabel(false)
  }, [session, labelDraft, showToast])

  const handleLabelCancel = useCallback(() => {
    setEditingLabel(false)
  }, [])

  // Summary state
  const [summaryData, setSummaryData] = useState<SessionSummaryResponse | null>(null)
  const [summaryExpanded, setSummaryExpanded] = useState(false)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryEditing, setSummaryEditing] = useState(false)
  const [summaryMode, setSummaryMode] = useState<'edit' | 'preview'>('edit')
  const [summaryDraft, setSummaryDraft] = useState('')
  const [summarySaving, setSummarySaving] = useState(false)
  const [renderedSummary, setRenderedSummary] = useState('')
  const [renderedSummaryDraft, setRenderedSummaryDraft] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Snapshot selector state
  const [viewingSnapshotId, setViewingSnapshotId] = useState<string | null>(null)
  const [snapshotContent, setSnapshotContent] = useState<string | null>(null)
  const [snapshotAssistant, setSnapshotAssistant] = useState<string | null>(null)
  const [renderedSnapshotContent, setRenderedSnapshotContent] = useState('')

  // Summary deletion state
  const [snapshotDeleteConfirm, setSnapshotDeleteConfirm] = useState<string | null>(null)
  const [showDeleteAllSummariesConfirm, setShowDeleteAllSummariesConfirm] = useState(false)
  const [deletingSummary, setDeletingSummary] = useState(false)
  const [showConsolidateConfirm, setShowConsolidateConfirm] = useState(false)

  // Navigation state
  const [navPosition, setNavPosition] = useState<{ current: number; total: number } | null>(null)

  // Set up navigation position from context
  useEffect(() => {
    const context = getSessionNavContext()
    if (!context || !projectId) {
      setNavPosition(null)
      return
    }

    const currentId = String(id)
    const idx = context.ids.indexOf(currentId)
    if (idx === -1) {
      setNavPosition(null)
      return
    }

    if (idx !== context.currentIndex) {
      updateSessionNavIndex(idx)
    }

    setNavPosition(getSessionPositionInfo())
  }, [id, projectId])

  const navigatePrev = useCallback(() => {
    const prevId = getPrevSessionId()
    if (prevId) {
      setLocation(`/sessions/${prevId}`)
    }
  }, [setLocation])

  const navigateNext = useCallback(() => {
    const nextId = getNextSessionId()
    if (nextId) {
      setLocation(`/sessions/${nextId}`)
    }
  }, [setLocation])

  // Get stored back URL and clear it (only used when not in project context)
  const [storedBackUrl] = useState(() => {
    if (projectId) return null // Don't use session storage when in project context
    const session = loadSession()
    const stored = session.sessionBackUrl
    if (stored) {
      saveSession({ sessionBackUrl: null })
    }
    return stored
  })

  // Compute back URL: ?from param > session storage > sessions list > /sessions
  const backUrl = (() => {
    const params = new URLSearchParams(window.location.search)
    const from = params.get('from')
    if (from) return decodeURIComponent(from)
    if (projectId) return `/sessions?project=${projectId}`
    return storedBackUrl || '/sessions'
  })()

  useEffect(() => {
    let cancelled = false

    async function load() {
      setIsLoading(true)
      setError(null)
      setSummaryExpanded(false)
      setSummaryEditing(false)
      setSummaryData(null)
      setViewingSnapshotId(null)
      setSnapshotContent(null)
      setSnapshotAssistant(null)

      try {
        const response = await getSession(id)
        if (cancelled) return

        setSession(response.session)
        setChunks(response.chunks || [])
      } catch (err: any) {
        if (cancelled) return
        setError(err.message || 'Failed to load session')
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [id])

  // Check whether the session is actively running in *another* terminal.
  // We only gate the in-browser Connect button when:
  //   1. The row has a live heartbeat pid (rules out mtime-only Tier 3 entries),
  //      and
  //   2. The pid is NOT owned by our own PTY daemon (rules out the in-browser
  //      claude we just spawned ourselves — that's a reattach, not a conflict).
  useEffect(() => {
    if (!session) return
    let mounted = true
    getActiveSessions(session.project ? { project_id: session.project.id } : undefined)
      .then((data) => {
        if (mounted) {
          const row = (data.sessions || []).find(s => s.session_id === session.session_id)
          setIsActive(!!row && row.pid != null && !row.pid_is_self)
        }
      })
      .catch(() => {})
    return () => { mounted = false }
  }, [session?.session_id])

  // Fetch estimated rehydrate token cost for this lineage (by nickname)
  useEffect(() => {
    if (!session?.nickname) {
      setLineageTokens(null)
      return
    }
    let mounted = true
    getSessionLineageTokenCount(session.nickname)
      .then((data) => {
        if (mounted) setLineageTokens(data)
      })
      .catch(() => {
        if (mounted) setLineageTokens(null)
      })
    return () => { mounted = false }
  }, [session?.nickname])

  // Fetch live phys_footprint for the session's PID (server hits a 30s cache).
  useEffect(() => {
    if (!session?.id || session.pid == null) {
      setLiveMemory(null)
      return
    }
    let mounted = true
    getSessionLiveMemory(session.id)
      .then((data) => { if (mounted) setLiveMemory(data) })
      .catch(() => { if (mounted) setLiveMemory(null) })
    return () => { mounted = false }
  }, [session?.id, session?.pid])

  const RAW_PAGE_SIZE = 500

  // Load raw entries when switching to raw mode — loads newest page first.
  // Uses the assistant-agnostic /sessions/:id/raw endpoint which resolves
  // file_path from the synced sessions row (works for both Claude and Codex).
  useEffect(() => {
    if (viewMode !== 'raw' || !session?.id) return
    let mounted = true
    setRawLoading(true)
    setRawEntries([])
    setRawLoadedAll(false)
    setRawTotalCount(0)
    setRawError(null)

    // Fetch last page: first call gets total_count, second fetches from the end
    getSessionRaw(session.id, { limit: 1, offset: 0 })
      .then(meta => {
        if (!mounted) return
        const total = meta.pagination?.total_count ?? 0
        setRawTotalCount(total)
        if (total === 0) {
          setRawLoadedAll(true)
          return
        }
        const offset = Math.max(0, total - RAW_PAGE_SIZE)
        return getSessionRaw(session.id, { limit: RAW_PAGE_SIZE, offset })
          .then(data => {
            if (!mounted) return
            setRawEntries(normalizeRawEntries(data.session?.entries || [], session.assistant?.handle))
            setRawSource(data.session?.source)
            setRawFilePath(data.session?.file_path)
            setRawLoadedAll(offset === 0)
          })
      })
      .catch((err) => {
        if (mounted) {
          setRawEntries([])
          setRawLoadedAll(true)
          const msg = err?.message || ''
          if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
            setRawError('Session file no longer exists on disk. The parsed view still has cached message chunks.')
          } else {
            setRawError(`Failed to load raw transcript: ${msg || 'Unknown error'}`)
          }
        }
      })
      .finally(() => {
        if (mounted) setRawLoading(false)
      })

    return () => { mounted = false }
  }, [viewMode, session?.id])

  // Refresh raw entries tail — append new entries that appeared since last load.
  // Triggered by SSE `session.updated` deltas so the Raw view stays live like Parsed.
  const refreshRawTail = useCallback(async () => {
    if (viewMode !== 'raw' || !session?.id) return
    if (rawLoading) return
    try {
      const meta = await getSessionRaw(session.id, { limit: 1, offset: 0 })
      const newTotal = meta.pagination?.total_count ?? 0
      if (newTotal <= rawTotalCount) return
      const delta = newTotal - rawTotalCount
      const data = await getSessionRaw(session.id, { limit: delta, offset: rawTotalCount })
      const newer = normalizeRawEntries(data.session?.entries || [], session.assistant?.handle)
      if (newer.length === 0) {
        setRawTotalCount(newTotal)
        return
      }
      setRawEntries(prev => [...prev, ...newer])
      setRawTotalCount(newTotal)
    } catch {
      // Silent — next delta or manual refresh will retry
    }
  }, [viewMode, session?.id, rawTotalCount, rawLoading])

  // Load more (older) raw entries
  const loadMoreRaw = useCallback(async () => {
    if (!session?.id || rawLoadedAll || rawLoadingMore) return
    setRawLoadingMore(true)
    try {
      // Current entries are from offset..total. Load the page before that.
      const currentOldestOffset = rawTotalCount - rawEntries.length
      const nextOffset = Math.max(0, currentOldestOffset - RAW_PAGE_SIZE)
      const nextLimit = currentOldestOffset - nextOffset
      if (nextLimit <= 0) { setRawLoadedAll(true); return }

      const data = await getSessionRaw(session.id, { limit: nextLimit, offset: nextOffset })
      const older = normalizeRawEntries(data.session?.entries || [], session.assistant?.handle)
      // Prepend older entries (they come before the existing ones in file order)
      setRawEntries(prev => [...older, ...prev])
      if (nextOffset === 0) setRawLoadedAll(true)
    } catch {
      // silent
    } finally {
      setRawLoadingMore(false)
    }
  }, [session?.id, rawEntries.length, rawTotalCount, rawLoadedAll, rawLoadingMore])

  // Pre-filter and sort raw entries for virtualized rendering
  const filteredRawEntries = useMemo(() => {
    const sorted = sortOrder === 'desc' ? [...rawEntries].reverse() : rawEntries
    return sorted.filter(entry => {
      if (!entry.message) return false
      if (!showUser && entry.type === 'user') return false
      if (!showAssistant && entry.type === 'assistant') return false
      if (searchQuery) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : (entry.message.content || []).map((b: SessionContentBlock) =>
              b.text || b.thinking || b.name || ''
            ).join(' ')
        if (!text.toLowerCase().includes(searchQuery.toLowerCase())) return false
      }
      if (showBashOnly) {
        if (entry.type !== 'assistant') return false
        const blocks = Array.isArray(entry.message.content) ? entry.message.content : []
        return blocks.some((b: SessionContentBlock) => b.type === 'tool_use' && (b.name === 'Bash' || b.input?.command))
      }
      if (showCommandsOnly) {
        const blocks = Array.isArray(entry.message.content) ? entry.message.content : []
        const hasBash = blocks.some((b: SessionContentBlock) => b.type === 'tool_use' && (b.name === 'Bash' || b.input?.command))
        const hasBashResult = blocks.some((b: SessionContentBlock) => b.type === 'tool_result')
        return hasBash || hasBashResult
      }
      const blocks = Array.isArray(entry.message.content) ? entry.message.content : []
      if (blocks.length > 0) {
        const hasVisibleBlock = blocks.some((b: SessionContentBlock) => {
          if (b.type === 'text' && b.text) return true
          if (b.type === 'thinking' && b.thinking && showThinking) return true
          if ((b.type === 'tool_use' || b.type === 'tool_result') && showTools) return true
          return false
        })
        if (!hasVisibleBlock) return false
      } else if (typeof entry.message.content === 'string' && !entry.message.content.trim()) {
        return false
      }
      return true
    })
  }, [rawEntries, sortOrder, showUser, showAssistant, showThinking, showTools, showBashOnly, showCommandsOnly, searchQuery])

  // Auto-refresh session data while active (poll every 10s)
  useEffect(() => {
    if (!isActive || !session) return
    let mounted = true

    const poll = setInterval(async () => {
      try {
        await triggerSessionSync()
        const response = await getSession(id)
        if (!mounted) return
        setSession(response.session)
        setChunks(response.chunks || [])
      } catch {
        // Silent — polling failure is non-critical
      }
    }, 10_000)

    return () => {
      mounted = false
      clearInterval(poll)
    }
  }, [isActive, session?.id, id])

  const stopSummaryPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const refreshSummary = useCallback(async (sessionId: string) => {
    try {
      const data = await getSessionSummary(sessionId)
      const wasPolling = pollRef.current !== null
      setSummaryData(data)

      if (wasPolling && data.summary && (!data.job || data.job.status === 'completed')) {
        setSummaryExpanded(true)
      }

      if (data.job && (data.job.status === 'pending' || data.job.status === 'running')) {
        if (!pollRef.current) {
          pollRef.current = setInterval(() => { void refreshSummary(sessionId) }, 3000)
        }
      } else {
        stopSummaryPolling()
      }
    } catch {
      setSummaryData(null)
      stopSummaryPolling()
    }
  }, [stopSummaryPolling])

  // Fetch summary on load + poll while job is pending/running
  useEffect(() => {
    if (!session) return
    void refreshSummary(session.id)
    return () => {
      stopSummaryPolling()
    }
  }, [session?.id, refreshSummary, stopSummaryPolling])

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [])

  // Render summary content as markdown (view mode)
  useEffect(() => {
    const content = summaryData?.summary?.content
    if (!content) { setRenderedSummary(''); return }
    let active = true
    renderMarkdown(content)
      .then(html => { if (active) setRenderedSummary(html) })
      .catch(() => { if (active) setRenderedSummary(content) })
    return () => { active = false }
  }, [summaryData?.summary?.content])

  // Render snapshot content as markdown (when viewing non-current snapshot)
  useEffect(() => {
    if (!snapshotContent) { setRenderedSnapshotContent(''); return }
    let active = true
    renderMarkdown(snapshotContent)
      .then(html => { if (active) setRenderedSnapshotContent(html) })
      .catch(() => { if (active) setRenderedSnapshotContent(snapshotContent) })
    return () => { active = false }
  }, [snapshotContent])

  // Render edit draft as markdown (preview mode)
  useEffect(() => {
    if (!summaryEditing || !summaryDraft) { setRenderedSummaryDraft(''); return }
    let active = true
    renderMarkdown(summaryDraft)
      .then(html => { if (active) setRenderedSummaryDraft(html) })
      .catch(() => { if (active) setRenderedSummaryDraft(summaryDraft) })
    return () => { active = false }
  }, [summaryEditing, summaryDraft])


  const handleSummarize = useCallback(async (mode: 'full' | 'incremental' | 'consolidate' = 'full') => {
    if (!session) return
    setSummaryLoading(true)
    try {
      // Always create a fresh job. Session summaries are time-dependent: the
      // transcript grows as new chunks are synced, so resuming a prior failed
      // job would reuse stale batch outputs against the frozen old transcript.
      // For mid-run transient failures on the *same* transcript, use
      // handleRetryFailed instead (resumes completed batches of the same job).
      const modelOpt = selectedModel ? selectedModel : undefined

      const { job } = await createKdagJob({
        job_type: 'session_summary',
        session_id: session.id,
        assistant_handle: selectedAssistant,
        model: modelOpt,
        mode,
      })
      // Start execution
      await runKdagJob(job.id, { model: modelOpt })
      // Set initial polling state
      setSummaryData({
        summary: null,
        snapshots: summaryData?.snapshots || [],
        job: { id: job.id, run_id: null, status: 'running' as KdagJobStatus, error: null, duration_ms: null, created_at: job.created_at, step_progress: null },
      })
      void refreshSummary(session.id)
    } catch (err: any) {
      // If 409, a job already exists — just refresh
      if (err?.response?.status === 409) {
        void refreshSummary(session.id)
      } else if (err?.response?.status === 400) {
        let detail = ''
        try {
          const body = await err.response.json()
          detail = body?.error || ''
        } catch {}
        showToast(detail || 'Could not start summary job')
      } else {
        showToast(err?.message || 'Failed to summarize session')
      }
    } finally {
      setSummaryLoading(false)
    }
  }, [session, selectedAssistant, selectedModel, summaryData?.job, summaryData?.snapshots, refreshSummary, showToast])

  const handleRetryFailed = useCallback(async () => {
    if (!session) return
    const failedJobId = summaryData?.job?.id
    if (!failedJobId || summaryData?.job?.status !== 'failed') return

    setSummaryLoading(true)
    try {
      const modelOpt = selectedModel ? selectedModel : undefined
      await retryKdagJob(failedJobId, { assistant_handle: selectedAssistant, model: modelOpt })
      setSummaryData(prev => prev && prev.job ? {
        ...prev,
        job: { ...prev.job, status: 'running' as KdagJobStatus, error: null },
      } : prev)
      void refreshSummary(session.id)
    } catch (err: any) {
      showToast(err?.message || 'Failed to retry summary job')
    } finally {
      setSummaryLoading(false)
    }
  }, [session, selectedAssistant, selectedModel, summaryData?.job, refreshSummary, showToast])

  const handleDescribe = useCallback(async () => {
    if (!session) return
    setDescribeLoading(true)
    try {
      const { job } = await createKdagJob({
        definition_key: 'describe-session',
        inputs: { session_id: session.session_id },
      })
      await runKdagJob(job.id)
      setDescribeJobId(job.id)
    } catch {
      setDescribeLoading(false)
    }
  }, [session])

  // Poll for describe job completion
  useEffect(() => {
    if (!describeJobId) return
    let mounted = true
    const poll = setInterval(async () => {
      try {
        const jobData = await getKdagJob(describeJobId)
        if (!mounted) return
        const latestRun = jobData.runs?.[jobData.runs.length - 1]
        const status = latestRun?.status
        if (status === 'completed' || status === 'failed') {
          // Refresh session to pick up the new summary label
          const response = await getSession(id)
          if (mounted) setSession(response.session)
          setDescribeLoading(false)
          setDescribeJobId(null)
        }
      } catch {}
    }, 3000)
    return () => { mounted = false; clearInterval(poll) }
  }, [describeJobId, id])

  const handleSummaryEdit = useCallback(() => {
    if (summaryData?.summary) {
      setSummaryDraft(summaryData.summary.content)
      setSummaryMode('edit')
      setSummaryEditing(true)
    }
  }, [summaryData?.summary])

  const handleSummarySave = useCallback(async () => {
    if (!session || !summaryDraft.trim()) return
    setSummarySaving(true)
    try {
      const { summary } = await updateSessionSummary(session.id, summaryDraft)
      setSummaryData(prev => prev ? {
        ...prev,
        summary: {
          ...prev.summary!,
          content: summary.content,
          updated_at: summary.updated_at,
        },
      } : prev)
      setSummaryEditing(false)
    } catch {
      // stay in edit mode on failure
    } finally {
      setSummarySaving(false)
    }
  }, [session, summaryDraft])

  const handleSummaryCancel = useCallback(() => {
    setSummaryEditing(false)
    setSummaryDraft('')
  }, [])

  const handleSnapshotChange = useCallback(async (snapshotId: string) => {
    if (!session || !summaryData) return

    // Switch back to current
    if (!snapshotId || snapshotId === summaryData.summary?.id) {
      setViewingSnapshotId(null)
      setSnapshotContent(null)
      setSnapshotAssistant(null)
      setSummaryEditing(false)
      return
    }

    setViewingSnapshotId(snapshotId)
    setSummaryEditing(false)
    try {
      const { snapshot } = await getSessionSummarySnapshot(session.id, snapshotId)
      setSnapshotContent(snapshot.content)
      setSnapshotAssistant(snapshot.assistant_handle)
    } catch {
      setSnapshotContent(null)
      setSnapshotAssistant(null)
    }
  }, [session, summaryData])

  const handleDeleteSnapshot = useCallback(async (snapshotId: string) => {
    if (!session) return
    setDeletingSummary(true)
    try {
      await deleteSessionSummarySnapshot(session.id, snapshotId)
      setViewingSnapshotId(null)
      setSnapshotContent(null)
      setSnapshotAssistant(null)
      setSummaryEditing(false)
      await refreshSummary(session.id)
      showToast('Snapshot deleted')
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete snapshot')
    } finally {
      setDeletingSummary(false)
      setSnapshotDeleteConfirm(null)
    }
  }, [session, refreshSummary, showToast])

  const handleDeleteAllSummaries = useCallback(async () => {
    if (!session) return
    setDeletingSummary(true)
    try {
      await deleteSessionSummary(session.id)
      setSummaryData(null)
      setViewingSnapshotId(null)
      setSnapshotContent(null)
      setSnapshotAssistant(null)
      setSummaryEditing(false)
      setSummaryExpanded(false)
      showToast('All summaries deleted')
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete summaries')
    } finally {
      setDeletingSummary(false)
      setShowDeleteAllSummariesConfirm(false)
    }
  }, [session, showToast])

  const [copiedMarkdown, setCopiedMarkdown] = useState(false)
  const [copiedSlack, setCopiedSlack] = useState(false)
  const [copiedAll, setCopiedAll] = useState(false)

  const handleCopyMarkdown = useCallback(async () => {
    if (!session) return
    try {
      const { text } = await exportSessionSummary(session.id, 'markdown')
      await navigator.clipboard.writeText(text)
      setCopiedMarkdown(true)
      setTimeout(() => setCopiedMarkdown(false), 2000)
    } catch (err) {
      console.error('Markdown copy failed:', err)
    }
  }, [session])

  const handleCopySlack = useCallback(async () => {
    if (!session) return
    try {
      const { text } = await exportSessionSummary(session.id, 'slack')
      await navigator.clipboard.writeText(text)
      setCopiedSlack(true)
      setTimeout(() => setCopiedSlack(false), 2000)
    } catch (err) {
      console.error('Slack copy failed:', err)
    }
  }, [session])

  const handleCopyAll = useCallback(async () => {
    if (!session) return
    try {
      const { text } = await exportSessionSummary(session.id, 'markdown', 'all')
      await navigator.clipboard.writeText(text)
      setCopiedAll(true)
      setTimeout(() => setCopiedAll(false), 2000)
    } catch (err) {
      console.error('All summaries copy failed:', err)
    }
  }, [session])

  // Chat input state
  const [isSending, setIsSending] = useState(false)
  const conversationRef = useRef<HTMLDivElement>(null)

  const refreshSession = useCallback(async () => {
    try {
      await triggerSessionSync({ force: true })
      const response = await getSession(id)
      setSession(response.session)
      setChunks(response.chunks || [])
    } catch {
      // Silent
    }
  }, [id])

  // Live updates: refetch session data when the watcher pushes a delta for this session.
  const liveRooms = useMemo(
    () => (session?.session_id ? [`session:${session.session_id}`] : []),
    [session?.session_id]
  )
  useLiveUpdates(
    liveRooms,
    useCallback(
      (_room, delta) => {
        if (delta.type !== 'session.updated' && delta.type !== 'session.ended') return
        getSession(id)
          .then((response) => {
            setSession(response.session)
            setChunks(response.chunks || [])
          })
          .catch(() => {
            // Silent — next delta or manual refresh will retry
          })
        if (viewMode === 'raw') {
          refreshRawTail()
        }
      },
      [id, viewMode, refreshRawTail]
    )
  )

  const handleSendMessage = useCallback(async (content: string) => {
    if (!session || !isActive) return
    setIsSending(true)
    try {
      await sendLiveMessage(session.session_id, content)
      showToast('Message sent')
    } catch (err: any) {
      showToast(err.message || 'Failed to send message')
    } finally {
      setIsSending(false)
    }
  }, [session, isActive, showToast])

  const handleTerminate = useCallback(async () => {
    if (!session || !isActive) return
    setIsTerminating(true)
    try {
      await terminateActiveSession(session.session_id)
      setIsActive(false)
      showToast('Session terminated')
    } catch {
      showToast('Failed to terminate session')
    } finally {
      setIsTerminating(false)
    }
  }, [session, isActive, showToast])

  const handleDelete = useCallback(async () => {
    if (!session) return
    try {
      await bulkDeleteSessions('claude-code', { sessionIds: [session.session_id] })
      // Navigate back to the sessions list
      const backUrl = projectId
        ? `/projects/${projectId}/sessions`
        : '/assistants/claude-code/sessions'
      setLocation(backUrl)
    } catch (err: any) {
      showToast(err.message || 'Failed to delete session')
    } finally {
      setShowDeleteConfirm(false)
    }
  }, [session, projectId, setLocation, showToast])

  // Summarize modal state
  const [showSummarizeModal, setShowSummarizeModal] = useState(false)

  const jobStatus = summaryData?.job?.status
  const hasSummary = !!summaryData?.summary
  const jobActive = jobStatus === 'pending' || jobStatus === 'running'
  const jobFailed = jobStatus === 'failed'
  const stepProgress = summaryData?.job?.step_progress

  // Snapshot viewing state
  const isViewingOldSnapshot = viewingSnapshotId !== null && viewingSnapshotId !== summaryData?.summary?.id
  const displayedContent = isViewingOldSnapshot ? renderedSnapshotContent : renderedSummary
  const displayedAssistant = isViewingOldSnapshot ? snapshotAssistant : summaryData?.summary?.assistant_handle
  const displayedSnapshotId = isViewingOldSnapshot ? viewingSnapshotId : summaryData?.summary?.id
  const snapshotsList = summaryData?.snapshots || []

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl+F to focus search
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        searchInputRef.current?.focus()
        return
      }

      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      if (e.key === 'Escape') {
        if (summaryEditing) {
          handleSummaryCancel()
        } else {
          setLocation(backUrl)
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        navigatePrev()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        navigateNext()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [backUrl, setLocation, navigatePrev, navigateNext, summaryEditing, handleSummaryCancel])

  // Format duration
  const formatDuration = (startedAt: string | null, endedAt: string | null) => {
    if (!startedAt || !endedAt) return null
    const start = new Date(startedAt).getTime()
    const end = new Date(endedAt).getTime()
    const diffMs = end - start
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMins / 60)
    const remainingMins = diffMins % 60

    if (diffHours > 0) {
      return remainingMins > 0 ? `${diffHours}h ${remainingMins}m` : `${diffHours}h`
    } else if (diffMins > 0) {
      return `${diffMins}m`
    }
    return '<1m'
  }

  // Parse all chunks into segments, apply role filters, search filter, and sort
  const allSegments = useMemo(() => {
    const parsed = chunks
      .flatMap(chunk => parseChunkContent(chunk.content, chunk.id))
      .filter(segment => segment.content.trim().length > 0)

    // Apply role filters — each chip controls its own segment type (additive)
    const filtered = parsed.filter(segment => {
      if (segment.role === 'tool_use') {
        if (!showTools) return false
        if (showBashOnly && segment.toolName !== 'Bash') return false
        return true
      }
      if (segment.role === 'tool_result') {
        if (!showTools) return false
        if (showBashOnly) return false
        return true
      }
      if (segment.role === 'user' && !showUser) return false
      if (segment.role === 'assistant' && !showAssistant) return false
      if (segment.role === 'thinking' && !showThinking) return false
      return true
    })

    const sorted = sortOrder === 'desc' ? [...filtered].reverse() : filtered

    if (!searchQuery.trim()) return sorted

    const query = searchQuery.toLowerCase()
    return sorted.filter(segment =>
      segment.content.toLowerCase().includes(query) ||
      segment.role.toLowerCase().includes(query) ||
      (segment.toolName?.toLowerCase().includes(query) ?? false)
    )
  }, [chunks, searchQuery, sortOrder, showUser, showAssistant, showThinking, showTools, showBashOnly, showCommandsOnly])

  if (isLoading) {
    return (
      <div class={styles.page}>
        <LoadingMessage stableKey={id} />
      </div>
    )
  }

  if (error || !session) {
    return (
      <div class={styles.page}>
        <div class={styles.error}>{error || 'Session not found'}</div>
      </div>
    )
  }

  const duration = formatDuration(session.started_at, session.ended_at)

  const sessionTitle = session.name || (session.started_at
    ? (() => {
        const d = new Date(session.started_at!)
        const pad = (n: number) => String(n).padStart(2, '0')
        return `session-started-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${String(d.getFullYear()).slice(2)}-${pad(d.getHours())}-${pad(d.getMinutes())}`
      })()
    : `session-${session.session_id.slice(0, 8)}`)

  return (
    <div class={clsx(styles.page, viewMode === 'terminal' && styles.pageWide)}>
      <div class={styles.stickyTop}>
      <header class={styles.header}>
        <div class={styles.backRow}>
          {session.project && (
            <span class={styles.breadcrumb}>
              <Link href={`/projects/${session.project.id}`} class={styles.projectLabel}>
                {session.project.display_name || session.project.name || session.project.handle}
              </Link>
              <span class={styles.breadcrumbSep}>/</span>
              <Link href={`/sessions?project=${session.project.handle || session.project.id}`} class={styles.projectLabel}>
                Sessions
              </Link>
            </span>
          )}
        </div>
        <div class={styles.titleSection}>
          <h1 class={styles.title}>
            {isActive && <span class={styles.statusDot} title="Active session" />}
            {session.assistant && (
              <AssistantBadge
                handle={session.assistant.handle}
                name={session.assistant.name}
                size="sm"
              />
            )}
            {session.nickname ? <span class={styles.nickname}>{session.nickname}</span> : sessionTitle}
            {lineageTokens && lineageTokens.estimated_tokens > 0 && (
              <button
                type="button"
                class={styles.rehydrateCost}
                onClick={() => {
                  navigator.clipboard.writeText('/rehydrate')
                  showToast('Copied /rehydrate')
                }}
                title={`Estimated cost to /rehydrate this lineage — ${lineageTokens.session_count} session${lineageTokens.session_count !== 1 ? 's' : ''} · ${lineageTokens.summary_count} summar${lineageTokens.summary_count !== 1 ? 'ies' : 'y'} · ${lineageTokens.compaction_count} compaction${lineageTokens.compaction_count !== 1 ? 's' : ''}. Click to copy /rehydrate.`}
              >
                ~{formatTokenCount(lineageTokens.estimated_tokens)} to rehydrate
              </button>
            )}
          </h1>
          {/* Meta row: description (left) + actions (right) */}
          <div class={styles.metaRow}>
            {editingLabel ? (
              <input
                ref={labelInputRef}
                type="text"
                class={styles.sessionSummaryInput}
                value={labelDraft}
                onInput={(e) => setLabelDraft((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleLabelSave()
                  else if (e.key === 'Escape') handleLabelCancel()
                }}
                onBlur={handleLabelSave}
                placeholder="Add a short summary..."
              />
            ) : (
              <p class={styles.sessionSummaryLabel} onClick={handleLabelEdit} title="Click to edit summary">
                {session.summary || <span class={styles.sessionSummaryPlaceholder}>Add summary...</span>}
                <Pencil size={12} class={styles.sessionSummaryEditIcon} />
              </p>
            )}
            <span class={styles.metaDivider} />
            {session.resumable && (
              <button
                class={styles.resumableBadge}
                onClick={() => {
                  navigator.clipboard.writeText(`claude --resume ${session.session_id}`)
                  showToast('Resume command copied')
                }}
                title={`Resumable — click to copy: claude --resume ${session.session_id}`}
              >
                <Play size={10} />
                Resumable
              </button>
            )}
            <button
              class={styles.summarizeButton}
              onClick={handleDescribe}
              disabled={describeLoading}
              title="Generate a short description for this session"
            >
              {describeLoading
                ? <Loader size={14} class={styles.spinning} />
                : <Sparkles size={14} />}
              {describeLoading ? 'Describing...' : 'Describe'}
            </button>
            {!hasSummary && !jobActive && !jobFailed && (
              <button
                class={styles.summarizeButton}
                onClick={() => setShowSummarizeModal(true)}
                disabled={summaryLoading || backendsLoading}
                title="Generate an AI summary of this session"
              >
                {summaryLoading
                  ? <Loader size={14} class={styles.spinning} />
                  : <Sparkles size={14} />}
                Summarize
              </button>
            )}
            {!hasSummary && !jobActive && jobFailed && (
              <>
                <button
                  class={styles.summaryRetry}
                  onClick={handleRetryFailed}
                  disabled={summaryLoading}
                  title={summaryData?.job?.error || 'Resume the failed job from completed batches (same transcript)'}
                >
                  {summaryLoading
                    ? <Loader size={14} class={styles.spinning} />
                    : <AlertTriangle size={14} />}
                  Retry
                </button>
                <button
                  class={styles.summarizeButton}
                  onClick={() => handleSummarize('full')}
                  disabled={summaryLoading || backendsLoading}
                  title="Discard the failed job and start a new summary on the current transcript"
                >
                  <Sparkles size={14} />
                  Start fresh
                </button>
              </>
            )}
            {jobActive && (
              <span class={styles.summaryStatus}>
                <Loader size={14} class={styles.spinning} />
                {stepProgress && stepProgress.total > 1
                  ? `Summarizing... (${stepProgress.completed}/${stepProgress.total})`
                  : 'Summarizing...'}
              </span>
            )}
            {hasSummary && (
              <button
                class={styles.summaryToggle}
                onClick={() => setSummaryExpanded(v => !v)}
              >
                {summaryExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                {summaryExpanded ? 'Hide Summary' : 'View Summary'}
              </button>
            )}
            {isActive && (
              <button
                class={styles.terminateButton}
                onClick={handleTerminate}
                disabled={isTerminating}
                title="Terminate this active session (SIGTERM)"
              >
                <Square size={12} />
                {isTerminating ? 'Terminating...' : 'Terminate'}
              </button>
            )}
            <button
              class={styles.deleteButton}
              onClick={() => setShowDeleteConfirm(true)}
              title="Delete session"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </header>

      {/* AI-generated summary panel */}
      {hasSummary && summaryExpanded && (
        <div class={styles.summaryPanel}>
          <div class={styles.summaryPanelHeader}>
            <Sparkles size={14} />
            <span>AI Summary</span>
            {displayedAssistant && (
              <span class={styles.assistantBadge}>{displayedAssistant}</span>
            )}
            {snapshotsList.length > 1 && (
              <select
                class={styles.snapshotSelect}
                value={viewingSnapshotId || summaryData?.summary?.id || ''}
                onChange={(e) => handleSnapshotChange((e.target as HTMLSelectElement).value)}
              >
                {snapshotsList.map((snap, i) => {
                  const num = snapshotsList.length - i
                  const isCurrent = snap.id === summaryData?.summary?.id
                  return (
                    <option key={snap.id} value={snap.id}>
                      #{num} — {snap.assistant_handle}{isCurrent ? ' (current)' : ''}
                    </option>
                  )
                })}
              </select>
            )}
            {summaryData?.summary?.updated_at && !isViewingOldSnapshot && (
              <span class={styles.summaryDate}>
                {new Date(summaryData.summary.updated_at).toLocaleString(undefined, {
                  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                })}
              </span>
            )}
            <div class={styles.summaryActions}>
              {summaryEditing && !isViewingOldSnapshot && (
                <div class={styles.summaryModeToggle} role="group" aria-label="Summary view">
                  <button
                    class={`${styles.summaryToggleBtn} ${summaryMode === 'edit' ? styles.summaryToggleBtnActive : ''}`}
                    onClick={() => setSummaryMode('edit')}
                    type="button"
                  >
                    Edit
                  </button>
                  <button
                    class={`${styles.summaryToggleBtn} ${summaryMode === 'preview' ? styles.summaryToggleBtnActive : ''}`}
                    onClick={() => setSummaryMode('preview')}
                    type="button"
                  >
                    Preview
                  </button>
                </div>
              )}
              {summaryEditing && !isViewingOldSnapshot ? (
                <>
                  <button
                    class={styles.summaryActionBtn}
                    onClick={handleSummaryCancel}
                    title="Cancel editing"
                  >
                    <X size={12} />
                  </button>
                  <button
                    class={`${styles.summaryActionBtn} ${styles.summaryActionSave}`}
                    onClick={handleSummarySave}
                    disabled={summarySaving}
                    title="Save changes (Cmd+S)"
                  >
                    {summarySaving ? <Loader size={12} class={styles.spinning} /> : <Check size={12} />}
                  </button>
                </>
              ) : !isViewingOldSnapshot ? (
                <button
                  class={styles.summaryActionBtn}
                  onClick={handleSummaryEdit}
                  title="Edit summary"
                >
                  <Pencil size={12} />
                </button>
              ) : null}
              <select
                class={styles.assistantSelectSmall}
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
              <button
                class={styles.regenerateBtn}
                onClick={() => handleSummarize('full')}
                disabled={summaryLoading || jobActive}
                title="Regenerate summary from scratch"
              >
                <RefreshCw size={12} />
                Regenerate
              </button>
              <button
                class={styles.updateBtn}
                onClick={() => handleSummarize('incremental')}
                disabled={summaryLoading || jobActive}
                title="Update summary with new session content since last summary"
              >
                <Sparkles size={12} />
                Update
              </button>
              {snapshotsList.length >= 1 && (
                <button
                  class={styles.updateBtn}
                  onClick={() => setShowConsolidateConfirm(true)}
                  disabled={summaryLoading || jobActive}
                  title="Merge all snapshots and any compaction records into one; old snapshots move to filesystem trash"
                  data-testid="session-summary--consolidate"
                >
                  <Sparkles size={12} />
                  Consolidate
                </button>
              )}
              {displayedSnapshotId && (
                <CopyButton text={displayedSnapshotId} size={12} title="Copy snapshot UUID" />
              )}
              {displayedSnapshotId && !summaryEditing && (
                <button
                  class={styles.summaryActionBtn}
                  onClick={() => setSnapshotDeleteConfirm(displayedSnapshotId)}
                  disabled={deletingSummary}
                  title={isViewingOldSnapshot ? 'Delete this snapshot' : 'Delete current snapshot'}
                  data-testid="session-summary--delete-snapshot"
                >
                  <Trash2 size={12} />
                </button>
              )}
              {snapshotsList.length > 1 && !summaryEditing && (
                <button
                  class={styles.summaryActionBtn}
                  onClick={() => setShowDeleteAllSummariesConfirm(true)}
                  disabled={deletingSummary}
                  title="Delete all summaries for this session"
                  data-testid="session-summary--delete-all"
                >
                  <Trash2 size={12} />
                  <span style={{ fontSize: '11px', marginLeft: '3px' }}>All</span>
                </button>
              )}
              <div class={styles.summaryCopyMenu}>
                <button class={styles.summaryCopyBtn} title="Copy as...">
                  <Copy size={12} />
                  Copy
                </button>
                <div class={styles.summaryCopyOptions}>
                  <button class={styles.summaryCopyOption} onClick={handleCopyMarkdown}>
                    {copiedMarkdown ? <Check size={14} /> : <FileText size={14} />}
                    {copiedMarkdown ? 'Copied' : 'Markdown'}
                  </button>
                  <button class={styles.summaryCopyOption} onClick={handleCopySlack}>
                    {copiedSlack ? <Check size={14} /> : <MessageSquareText size={14} />}
                    {copiedSlack ? 'Copied' : 'Slack'}
                  </button>
                  {snapshotsList.length > 1 && (
                    <button class={styles.summaryCopyOption} onClick={handleCopyAll}>
                      {copiedAll ? <Check size={14} /> : <Copy size={14} />}
                      {copiedAll ? 'Copied' : 'All Summaries'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
          {summaryEditing && !isViewingOldSnapshot && summaryMode === 'edit' ? (
            <div class={styles.summaryEditor}>
              <CodeEditor
                value={summaryDraft}
                onChange={setSummaryDraft}
                language="markdown"
                onSave={handleSummarySave}
                lineWrapping
                autoFocus
              />
            </div>
          ) : (
            <div
              class={styles.summaryMarkdown}
              dangerouslySetInnerHTML={{ __html: summaryEditing && !isViewingOldSnapshot ? renderedSummaryDraft : displayedContent }}
            />
          )}
        </div>
      )}

      <SessionToolbar
        class={styles.toolbar}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        showTerminalToggle={true}
        showUser={showUser}
        onShowUserChange={setShowUser}
        showAssistant={showAssistant}
        onShowAssistantChange={setShowAssistant}
        showThinking={showThinking}
        onShowThinkingChange={setShowThinking}
        showTools={showTools}
        onShowToolsChange={setShowTools}
        showCommandsOnly={showCommandsOnly}
        onShowCommandsOnlyChange={setShowCommandsOnly}
        showBashOnly={showBashOnly}
        onShowBashOnlyChange={setShowBashOnly}
        onExpandToggle={(exp) => { setAllExpanded(exp); setToggledBlocks(new Set()) }}
        sortOrder={sortOrder}
        onSortChange={setSortOrder}
        onRefresh={refreshSession}
        dbSessionId={session.id}
        onCopyDbSessionId={() => showToast('Session UUID copied')}
        sessionId={session.session_id}
        filePath={rawFilePath || session.file_path || undefined}
        statsSlot={
          <>
            {session.pid != null && (
              <span
                class={styles.metaItem}
                title={`Process ID ${session.pid}${liveMemory?.memory_human ? ` · ${liveMemory.memory_human} phys_footprint` : ''} — click to copy PID`}
                onClick={() => {
                  navigator.clipboard.writeText(String(session.pid))
                  showToast(`Copied PID ${session.pid}`)
                }}
                style={{ cursor: 'pointer' }}
              >
                PID {session.pid}
                {liveMemory?.memory_human && (
                  <span class={styles.pidMemory}>{liveMemory.memory_human}</span>
                )}
              </span>
            )}
            {session.message_count && (
              <span class={styles.metaItem}>
                <FileText size={14} />
                {session.message_count} msgs
              </span>
            )}
            {duration && (
              <span class={styles.metaItem}>
                <Clock size={14} />
                {duration}
              </span>
            )}
            {session.context_window_tokens != null && session.context_window_tokens > 0 && (() => {
              const ctxTokens = session.context_window_tokens!
              const maxTokens = getContextWindowSize(session.model)
              const pct = maxTokens ? Math.round((ctxTokens / maxTokens) * 100) : null
              return (
                <span
                  class={styles.contextUsage}
                  title={`Context: ${formatTokenCount(ctxTokens)}${maxTokens ? ` / ${formatTokenCount(maxTokens)}` : ''} tokens (last turn)`}
                >
                  {maxTokens && (
                    <span class={styles.contextBar}>
                      <span
                        class={styles.contextFill}
                        style={{ width: `${Math.min(pct!, 100)}%` }}
                      />
                    </span>
                  )}
                  <span>{formatTokenCount(ctxTokens)}{maxTokens ? `/${formatTokenCount(maxTokens)}` : ''}</span>
                  {pct != null && <span class={styles.contextPct}>({pct}%)</span>}
                </span>
              )
            })()}
          </>
        }
      />
      </div>

      <div class={styles.conversation} ref={conversationRef}>
        {/* Keep the live PTY mounted across view switches so toggling to
            Parsed or Raw does not tear down the websocket. We hide via CSS
            instead of unmounting; the existing ResizeObserver re-fits xterm
            when the host element regains layout. */}
        {session?.session_id && (
          <div class={viewMode === 'terminal' ? styles.terminalShell : styles.terminalShellHidden}>
            <SessionTerminal
              sessionId={session.session_id}
              filePath={session.file_path}
            />
          </div>
        )}
        {viewMode === 'terminal' ? null : viewMode === 'parsed' ? (
          <VirtualList
            items={allSegments}
            containerRef={conversationRef}
            estimateHeight={120}
            identity={`${id}-parsed-${allSegments.length}`}
            renderItem={(segment) => {
              if (segment.role === 'tool_use') {
                const isCommand = segment.toolName === 'Bash'
                return (
                  <div
                    class={styles.toolBlock}
                    onContextMenu={(e: MouseEvent) => {
                      e.preventDefault()
                      setContextMenu({ chunkId: segment.chunkId, position: { x: e.clientX, y: e.clientY } })
                    }}
                  >
                    <div
                      class={clsx(styles.toolHeader, isCommand && styles.toolHeaderCommand)}
                      style={{ cursor: 'default' }}
                    >
                      <Code size={12} />
                      <span>Tool: {segment.toolName || 'unknown'}</span>
                    </div>
                    <pre class={styles.toolBody}>{segment.content}</pre>
                  </div>
                )
              }
              if (segment.role === 'tool_result') {
                return (
                  <div
                    class={styles.toolBlock}
                    onContextMenu={(e: MouseEvent) => {
                      e.preventDefault()
                      setContextMenu({ chunkId: segment.chunkId, position: { x: e.clientX, y: e.clientY } })
                    }}
                  >
                    <div class={styles.toolHeader} style={{ cursor: 'default' }}>
                      <Code size={12} />
                      <span>Tool Result: {segment.toolName || 'unknown'}</span>
                    </div>
                    <pre class={styles.toolBody}>{segment.content}</pre>
                  </div>
                )
              }
              return (
                <div
                  class={`${styles.segment} ${styles[segment.role]}`}
                  onContextMenu={(e: MouseEvent) => {
                    e.preventDefault()
                    setContextMenu({ chunkId: segment.chunkId, position: { x: e.clientX, y: e.clientY } })
                  }}
                >
                  <div class={styles.segmentHeader}>
                    {segment.role === 'user' ? (
                      <>
                        <User size={14} />
                        <span>User</span>
                      </>
                    ) : segment.role === 'thinking' ? (
                      <>
                        <Bot size={14} />
                        <span>Thinking</span>
                      </>
                    ) : (
                      <>
                        <Bot size={14} />
                        <span>Assistant</span>
                      </>
                    )}
                  </div>
                  <div class={styles.segmentContent}>{segment.content}</div>
                </div>
              )
            }}
          />
        ) : rawLoading ? (
          <LoadingMessage stableKey={id} />
        ) : rawError ? (
          <div class={styles.rawError}>
            <div class={styles.rawErrorTitle}>Raw transcript unavailable</div>
            <div class={styles.rawErrorText}>{rawError}</div>
            <div class={styles.rawErrorHint}>Try the Parsed view to see cached message chunks.</div>
          </div>
        ) : (
          <>
          {rawSource === 'backup' && (
            <ArchiveBadge class={styles.archiveBadge} />
          )}
          {sortOrder === 'asc' && !rawLoadedAll && (
            <button class={styles.loadMoreButton} onClick={loadMoreRaw} disabled={rawLoadingMore}>
              {rawLoadingMore ? 'Loading...' : `Load older entries (${rawEntries.length} of ${rawTotalCount})`}
            </button>
          )}
          <VirtualList
            items={filteredRawEntries}
            containerRef={conversationRef}
            estimateHeight={80}
            identity={`${id}-raw-${filteredRawEntries.length}-${sortOrder}`}
            renderItem={(entry, i) => {
              const blocks: SessionContentBlock[] = typeof entry.message?.content === 'string'
                ? [{ type: 'text', text: entry.message.content }]
                : (entry.message?.content || [])

              return (
                <div class={`${styles.segment} ${styles[entry.type] || ''}`}>
                  <div class={styles.segmentHeader}>
                    {entry.type === 'user' ? <><User size={14} /> <span>User</span></> : <><Bot size={14} /> <span>Assistant</span></>}
                    {entry.message?.model && <span class={styles.modelBadge}>{entry.message.model}</span>}
                  </div>
                  {blocks.map((block, bi) => {
                    const blockKey = `${i}-${bi}`

                    if (block.type === 'text' && block.text) {
                      return <div key={blockKey} class={styles.segmentContent}>{block.text}</div>
                    }

                    if (block.type === 'thinking' && block.thinking) {
                      if (!showThinking) return null
                      return (
                        <div key={blockKey} class={`${styles.segment} ${styles.thinking}`} style={{ marginTop: '4px' }}>
                          <div class={styles.segmentHeader}><Bot size={12} /> <span>Thinking</span></div>
                          <div class={styles.segmentContent}>{block.thinking}</div>
                        </div>
                      )
                    }

                    if (block.type === 'tool_use') {
                      if (!showTools) return null
                      const isCommand = block.name === 'Bash' || !!(block.input?.command)
                      const isExpanded = allExpanded !== null
                        ? allExpanded
                        : isCommand ? !toggledBlocks.has(blockKey) : toggledBlocks.has(blockKey)
                      return (
                        <div key={blockKey} class={styles.toolBlock}>
                          <button
                            class={clsx(styles.toolHeader, isCommand && styles.toolHeaderCommand)}
                            onClick={() => { setAllExpanded(null); setToggledBlocks(prev => {
                              const next = new Set(prev)
                              next.has(blockKey) ? next.delete(blockKey) : next.add(blockKey)
                              return next
                            }) }}
                          >
                            <ChevronRight size={12} class={clsx(styles.toolChevron, isExpanded && styles.toolChevronOpen)} />
                            <Code size={12} />
                            <span>Tool: {block.name || 'unknown'}</span>
                          </button>
                          {isExpanded && (
                            <pre class={styles.toolBody}>{block.input ? JSON.stringify(block.input, null, 2) : '(no input)'}</pre>
                          )}
                        </div>
                      )
                    }

                    if (block.type === 'tool_result') {
                      if (!showTools) return null
                      const isExpanded = allExpanded !== null ? allExpanded : toggledBlocks.has(blockKey)
                      const resultStr = typeof block.content === 'string'
                        ? block.content
                        : block.content ? JSON.stringify(block.content, null, 2) : '(no result)'
                      return (
                        <div key={blockKey} class={styles.toolBlock}>
                          <button
                            class={styles.toolHeader}
                            onClick={() => { setAllExpanded(null); setToggledBlocks(prev => {
                              const next = new Set(prev)
                              next.has(blockKey) ? next.delete(blockKey) : next.add(blockKey)
                              return next
                            }) }}
                          >
                            <ChevronRight size={12} class={clsx(styles.toolChevron, isExpanded && styles.toolChevronOpen)} />
                            <span>Tool Result</span>
                          </button>
                          {isExpanded && (
                            <pre class={styles.toolBody}>{resultStr}</pre>
                          )}
                        </div>
                      )
                    }

                    return null
                  })}
                </div>
              )
            }}
          />
          {sortOrder === 'desc' && !rawLoadedAll && (
            <button class={styles.loadMoreButton} onClick={loadMoreRaw} disabled={rawLoadingMore}>
              {rawLoadingMore ? 'Loading...' : `Load older entries (${rawEntries.length} of ${rawTotalCount})`}
            </button>
          )}
          </>
        )}
      </div>

      {isActive && !rawLoading && viewMode !== 'terminal' && (
        <ChatInput
          onSend={handleSendMessage}
          sending={isSending}
          placeholder="Send a live message... (Cmd+Enter)"
        />
      )}

      {navPosition && (
        <div class={styles.bottomNav}>
          <button
            class={styles.navButton}
            onClick={navigatePrev}
            title="Previous session (Left arrow)"
            aria-label="Previous session"
          >
            <ChevronLeft size={18} />
          </button>
          <span class={styles.navPosition} data-testid="nav-position">
            {navPosition.current} of {navPosition.total}
          </span>
          <button
            class={styles.navButton}
            onClick={navigateNext}
            title="Next session (Right arrow)"
            aria-label="Next session"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      )}

      {/* Summarize modal */}
      {showSummarizeModal && (
        <div
          class={styles.modalOverlay}
          onClick={(e) => { if (e.target === e.currentTarget) setShowSummarizeModal(false) }}
          role="dialog"
          aria-modal="true"
        >
          <div class={styles.modal}>
            <h2 class={styles.modalTitle}>Summarize Session</h2>
            <div class={styles.modalField}>
              <label class={styles.modalLabel}>Assistant</label>
              <select
                class={styles.modalSelect}
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
            </div>
            <div class={styles.modalField}>
              <label class={styles.modalLabel}>Model</label>
              <select
                class={styles.modalSelect}
                value={selectedModel}
                onChange={(e) => setSelectedModel((e.target as HTMLSelectElement).value)}
              >
                <option value="">Default</option>
                {(selectedBackend?.models || []).map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div class={styles.modalActions}>
              <button
                class={styles.modalCancel}
                onClick={() => setShowSummarizeModal(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                class={styles.modalConfirm}
                onClick={() => {
                  setShowSummarizeModal(false)
                  handleSummarize('full')
                }}
                disabled={summaryLoading}
                type="button"
              >
                <Sparkles size={14} />
                Summarize
              </button>
            </div>
          </div>
        </div>
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

      {snapshotDeleteConfirm && (
        <ConfirmModal
          title="Delete Snapshot"
          message={
            snapshotDeleteConfirm === summaryData?.summary?.id && snapshotsList.length > 1
              ? 'Delete the current summary snapshot? The next most recent snapshot will become current.'
              : snapshotDeleteConfirm === summaryData?.summary?.id
                ? 'Delete the only summary snapshot? This session will have no summary.'
                : 'Delete this snapshot? This cannot be undone.'
          }
          confirmLabel="Delete"
          variant="danger"
          onConfirm={() => handleDeleteSnapshot(snapshotDeleteConfirm)}
          onCancel={() => setSnapshotDeleteConfirm(null)}
        />
      )}

      {showDeleteAllSummariesConfirm && (
        <ConfirmModal
          title="Delete All Summaries"
          message={`Delete all ${snapshotsList.length} summary snapshots for this session? This cannot be undone.`}
          confirmLabel="Delete All"
          variant="danger"
          onConfirm={handleDeleteAllSummaries}
          onCancel={() => setShowDeleteAllSummariesConfirm(false)}
        />
      )}

      {showConsolidateConfirm && (
        <ConfirmModal
          title="Consolidate Summaries"
          message={`Merge all ${snapshotsList.length} summary snapshot(s) plus any compaction records for this session into one consolidated summary? The old snapshots will be moved to /tmp/khef-trash/session-summaries/ and removed from the database. Compaction records remain in place.`}
          confirmLabel="Consolidate"
          variant="danger"
          onConfirm={() => {
            setShowConsolidateConfirm(false)
            void handleSummarize('consolidate')
          }}
          onCancel={() => setShowConsolidateConfirm(false)}
        />
      )}

      {contextMenu && (
        <SessionContextMenu
          sessionId={contextMenu.chunkId}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
          onShowToast={showToast}
        />
      )}
    </div>
  )
}
