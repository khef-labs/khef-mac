import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks'
import { useLocation, Link } from 'wouter-preact'
import {
  MessageSquare, Send, Loader2, Square,
  Pencil, Trash2, Copy, Check,
  PanelLeftClose, PanelLeft, Search, X,
} from 'lucide-preact'
import { GeminiChatOptions, type GeminiOptions } from '../components/chat/GeminiChatOptions'
import {
  sendChatMessage,
  listAllChats,
  getChatById,
  deleteChatById,
  renameChatById,
  deleteChatMessageById,
  deleteAllChats,
  getProjects,
  getActiveSessions,
  getSessions,
} from '../lib/api'
import type {
  ActiveSession, AssistantChat, AssistantChatMessage, ChatDelegation, Project, SendChatResponse,
} from '../types'
import { useToast, ConfirmModal } from '../components/ui'
import { ConversationContextMenu } from '../components/shared/ConversationContextMenu'
import { SessionContextMenu } from '../components/shared/SessionContextMenu'
import { SessionTerminal } from '../components/session'
import { renderMarkdown } from '../lib/markdown'
import { getSettings, isDesktopApp } from '../lib/settings'
import { useDocumentTitle } from '../hooks'
import styles from './ChatPage.module.css'

type Backend = 'claude-code' | 'codex-cli' | 'gemini'

const BACKEND_LABELS: Record<Backend, string> = {
  'claude-code': 'Claude',
  'codex-cli': 'Codex',
  'gemini': 'Gemini',
}

const BACKEND_PILL_CLASS: Record<Backend, string> = {
  'claude-code': styles.backendClaude,
  'codex-cli': styles.backendCodex,
  'gemini': styles.backendGemini,
}

const BACKEND_BADGE_CLASS: Record<Backend, string> = {
  'claude-code': styles.badgeClaude,
  'codex-cli': styles.badgeCodex,
  'gemini': styles.badgeGemini,
}

const FILTER_BACKENDS: Backend[] = ['claude-code', 'codex-cli', 'gemini']

const CLAUDE_MODELS: { value: string; label: string }[] = [
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

const CODEX_MODELS: { value: string; label: string }[] = [
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
  { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
  { value: 'gpt-5.2', label: 'GPT-5.2' },
  { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
]

function getGeminiModels(): { value: string; label: string }[] {
  const settings = getSettings()
  return settings.gemini.models.map(m => ({ value: m.id, label: m.label }))
}

function getDefaultModel(backend: Backend): string {
  if (backend === 'gemini') return getSettings().gemini.defaultModel
  if (backend === 'codex-cli') return 'gpt-5.3-codex'
  return 'claude-sonnet-4-6'
}

function getModelsForBackend(backend: Backend): { value: string; label: string }[] {
  if (backend === 'codex-cli') return CODEX_MODELS
  if (backend === 'gemini') return getGeminiModels()
  return CLAUDE_MODELS
}

const SIDEBAR_KEY = 'khef-chat-sidebar-collapsed'
const SIDEBAR_SESSION_CAP = 25
const PINNED_KEY = (backend: Backend) => `khefChatSidebarPinned:${backend}`
const HIDDEN_KEY = (backend: Backend) => `khefChatSidebarHidden:${backend}`
const ORDER_KEY = (backend: Backend) => `khefChatSidebarOrder:${backend}`

interface PinnedSession {
  session_id: string
  nickname?: string | null
  file_path?: string | null
  project_name?: string | null
}

function readPinnedSessions(backend: Backend): PinnedSession[] {
  try {
    const raw = window.localStorage.getItem(PINNED_KEY(backend))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is PinnedSession => p && typeof p === 'object' && typeof p.session_id === 'string')
  } catch {
    return []
  }
}

function writePinnedSessions(backend: Backend, list: PinnedSession[]): void {
  try {
    window.localStorage.setItem(PINNED_KEY(backend), JSON.stringify(list))
  } catch { /* ignore quota / private-mode failures */ }
}

function readHiddenSessions(backend: Backend): string[] {
  try {
    const raw = window.localStorage.getItem(HIDDEN_KEY(backend))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

function writeHiddenSessions(backend: Backend, list: string[]): void {
  try {
    window.localStorage.setItem(HIDDEN_KEY(backend), JSON.stringify(list))
  } catch { /* ignore */ }
}

function readSidebarOrder(backend: Backend): string[] {
  try {
    const raw = window.localStorage.getItem(ORDER_KEY(backend))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

function writeSidebarOrder(backend: Backend, list: string[]): void {
  try {
    window.localStorage.setItem(ORDER_KEY(backend), JSON.stringify(list))
  } catch { /* ignore */ }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function formatAssistantName(handle: string): string {
  const known = BACKEND_LABELS[handle as Backend]
  if (known) return known
  return handle
    .split('-')
    .map(part => (part ? `${part[0].toUpperCase()}${part.slice(1)}` : part))
    .join(' ')
}

interface ChatPageProps {
  id?: string
  isNew?: boolean
}

export function ChatPage({ id, isNew }: ChatPageProps) {
  const [, setLocation] = useLocation()
  const { showToast } = useToast()

  // Sidebar state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return sessionStorage.getItem(SIDEBAR_KEY) === '1'
  })
  const toggleSidebar = () => {
    setSidebarCollapsed(prev => {
      const next = !prev
      sessionStorage.setItem(SIDEBAR_KEY, next ? '1' : '0')
      return next
    })
  }

  // Sidebar chat list
  const [chatList, setChatList] = useState<AssistantChat[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [sourceFilter, setSourceFilter] = useState<'ui' | 'mcp'>('ui')
  const [backendFilter, setBackendFilter] = useState<Backend | 'all'>(FILTER_BACKENDS[0])
  const refreshKey = useRef(0)
  const autoSelectRef = useRef(!id && !isNew)

  const refreshChatList = useCallback(() => {
    refreshKey.current++
    const key = refreshKey.current
    setListLoading(true)
    listAllChats({
      source: sourceFilter,
      assistant_handle: backendFilter !== 'all' ? backendFilter : undefined,
      limit: 50,
    })
      .then(res => {
        if (key !== refreshKey.current) return
        setChatList(res.chats)
        if (autoSelectRef.current && res.chats.length > 0) {
          setLocation(`/chat/${res.chats[0].id}`)
        }
        autoSelectRef.current = false
      })
      .catch(() => {})
      .finally(() => {
        if (key === refreshKey.current) setListLoading(false)
      })
  }, [sourceFilter, backendFilter])

  useEffect(() => { refreshChatList() }, [refreshChatList])

  // Context menu
  const [contextMenu, setContextMenu] = useState<{
    chat: AssistantChat
    position: { x: number; y: number }
  } | null>(null)

  const handleContextMenu = (e: MouseEvent, chat: AssistantChat) => {
    e.preventDefault()
    setContextMenu({ chat, position: { x: e.clientX, y: e.clientY } })
  }

  const handleContextDelete = () => {
    if (!contextMenu) return
    const chatToDelete = contextMenu.chat
    setContextMenu(null)
    deleteChatById(chatToDelete.id)
      .then(() => {
        showToast('Chat deleted')
        setChatList(prev => prev.filter(c => c.id !== chatToDelete.id))
        if (id === chatToDelete.id) setLocation('/chat')
      })
      .catch(err => showToast(err instanceof Error ? err.message : 'Failed to delete'))
  }

  const handleContextRename = () => {
    if (!contextMenu) return
    const chat = contextMenu.chat
    setContextMenu(null)
    setRenamingChatId(chat.id)
    setRenameValue(chat.title || '')
    setTimeout(() => renameInputRef.current?.select(), 0)
  }

  const handleRenameSave = async () => {
    if (!renamingChatId || !renameValue.trim()) return
    try {
      await renameChatById(renamingChatId, renameValue.trim())
      setChatList(prev => prev.map(c =>
        c.id === renamingChatId ? { ...c, title: renameValue.trim() } : c
      ))
      showToast('Chat renamed')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to rename')
    }
    setRenamingChatId(null)
  }

  const handleRenameCancel = () => {
    setRenamingChatId(null)
  }

  const handleRenameKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleRenameSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleRenameCancel()
    }
  }

  // Active chat state
  const [messages, setMessages] = useState<AssistantChatMessage[]>([])
  const [delegations, setDelegations] = useState<Record<string, ChatDelegation[]>>({})
  const [chatLoading, setChatLoading] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [currentChatId, setCurrentChatId] = useState<string | null>(id || null)
  const [currentBackend, setCurrentBackend] = useState<Backend>('claude-code')
  const [currentSource, setCurrentSource] = useState<string>('ui')
  const [currentCaller, setCurrentCaller] = useState<string | null>(null)
  const [newChatBackend, setNewChatBackend] = useState<Backend>('claude-code')
  const [selectedModel, setSelectedModel] = useState<string>(getDefaultModel('claude-code'))
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false)
  const [deleteMessageTarget, setDeleteMessageTarget] = useState<string | null>(null)
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renderedHtml, setRenderedHtml] = useState<Record<string, string>>({})
  const [geminiOptions, setGeminiOptions] = useState<GeminiOptions>({
    useThinking: false,
    thinkingBudget: 8192,
    useGoogleSearch: false,
    systemPrompt: '',
  })
  // Spawn cwd for fresh PTYs (Claude / Codex chat). Empty = let API fall back
  // to $HOME. Persisted per-backend in localStorage so users don't have to
  // retype on every refresh.
  const [terminalCwd, setTerminalCwd] = useState<string>('')
  const [ptyProjects, setPtyProjects] = useState<Project[]>([])
  // Live active sessions for the focused CLI assistant (claude-code / codex-cli)
  // and the currently-focused row in the sidebar. When set, the main area
  // mounts SessionTerminal in resume mode against that session.
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([])
  // Focused row may be from the live active-sessions feed OR from the
  // pinned-by-lookup list, so we keep just what the main area needs and
  // render richer details from activeSessions when available.
  const [focusedActiveSession, setFocusedActiveSession] = useState<{
    session_id: string
    file_path: string | null
    nickname?: string | null
    project_name?: string | null
  } | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const skipNextFetchRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)

  const currentChatTitle = chatList.find((c) => c.id === currentChatId)?.title
  useDocumentTitle(
    isNew || !currentChatId
      ? 'Chat - New'
      : currentChatTitle
        ? `Chat - ${currentChatTitle}`
        : 'Chat',
  )

  // Resolve active backend for model selector
  const activeBackend: Backend = currentChatId ? currentBackend : newChatBackend
  const availableModels = getModelsForBackend(activeBackend)

  // Keep selected model in sync when backend changes
  useEffect(() => {
    const models = getModelsForBackend(activeBackend)
    if (!models.some(m => m.value === selectedModel)) {
      setSelectedModel(getDefaultModel(activeBackend))
    }
  }, [activeBackend])

  // Load persisted PTY cwd whenever the active CLI backend changes (claude/codex).
  useEffect(() => {
    if (activeBackend !== 'claude-code' && activeBackend !== 'codex-cli') return
    try {
      const saved = window.localStorage.getItem(`khefChatCwd:${activeBackend}`) || ''
      setTerminalCwd(saved)
    } catch {
      setTerminalCwd('')
    }
  }, [activeBackend])

  // Persist PTY cwd as the user types so it survives refresh.
  useEffect(() => {
    if (activeBackend !== 'claude-code' && activeBackend !== 'codex-cli') return
    try {
      window.localStorage.setItem(`khefChatCwd:${activeBackend}`, terminalCwd)
    } catch { /* ignore quota/private-mode failures */ }
  }, [activeBackend, terminalCwd])

  // Pull khef projects with a known path so the user can pick one as cwd.
  useEffect(() => {
    if (activeBackend !== 'claude-code' && activeBackend !== 'codex-cli') return
    if (ptyProjects.length > 0) return
    let cancelled = false
    getProjects().then(list => {
      if (cancelled) return
      setPtyProjects(list.filter(p => !!p.path))
    }).catch(() => { /* ignore — picker just stays empty */ })
    return () => { cancelled = true }
  }, [activeBackend, ptyProjects.length])

  // Poll active sessions for the focused CLI assistant. Drops on backend
  // change so we don't show stale rows from another assistant.
  useEffect(() => {
    if (activeBackend !== 'claude-code' && activeBackend !== 'codex-cli') {
      setActiveSessions([])
      setFocusedActiveSession(null)
      return
    }
    let cancelled = false
    const fetchOnce = async () => {
      try {
        const data = await getActiveSessions({ assistant: activeBackend, status: 'active' })
        if (cancelled) return
        setActiveSessions(data.sessions || [])
      } catch { /* ignore — sidebar just stays as it was */ }
    }
    fetchOnce()
    const t = setInterval(fetchOnce, 5000)
    return () => { cancelled = true; clearInterval(t) }
  }, [activeBackend])

  // Pinned and hidden sessions for the sidebar (per CLI backend).
  // Pinned rows let the user keep an arbitrary session reachable from chat
  // even when it isn't currently active. Hidden rows let them dismiss noisy
  // active sessions without losing them — a follow-up pin via the lookup
  // input un-hides automatically.
  const [pinnedSessions, setPinnedSessions] = useState<PinnedSession[]>([])
  const [hiddenSessionIds, setHiddenSessionIds] = useState<string[]>([])
  const [sidebarOrder, setSidebarOrder] = useState<string[]>([])
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const isCliBackend = activeBackend === 'claude-code' || activeBackend === 'codex-cli'

  useEffect(() => {
    if (!isCliBackend) {
      setPinnedSessions([])
      setHiddenSessionIds([])
      setSidebarOrder([])
      return
    }
    setPinnedSessions(readPinnedSessions(activeBackend))
    setHiddenSessionIds(readHiddenSessions(activeBackend))
    setSidebarOrder(readSidebarOrder(activeBackend))
  }, [activeBackend, isCliBackend])

  // Drop the focused-session pin if it disappears from the active list AND
  // isn't held in the pinned list either. Pinned rows survive an active-side
  // drop so the user can keep working with them after, e.g., a brief PTY
  // restart.
  useEffect(() => {
    if (!focusedActiveSession) return
    const inActive = activeSessions.some(s => s.session_id === focusedActiveSession.session_id)
    const inPinned = pinnedSessions.some(p => p.session_id === focusedActiveSession.session_id)
    if (!inActive && !inPinned) setFocusedActiveSession(null)
  }, [activeSessions, focusedActiveSession, pinnedSessions])

  // Lookup input + debounced search results.
  const [lookupQuery, setLookupQuery] = useState('')
  const [lookupResults, setLookupResults] = useState<Array<{
    session_id: string; nickname?: string | null; file_path?: string | null; project_name?: string | null
  }>>([])
  const [lookupLoading, setLookupLoading] = useState(false)
  const [lookupOpen, setLookupOpen] = useState(false)

  useEffect(() => {
    if (!isCliBackend) { setLookupResults([]); return }
    const trimmed = lookupQuery.trim()
    if (!trimmed) { setLookupResults([]); setLookupLoading(false); return }
    let cancelled = false
    setLookupLoading(true)
    const t = setTimeout(async () => {
      try {
        const isUuid = UUID_RE.test(trimmed)
        const data = await getSessions({
          assistant: activeBackend,
          // Nickname-prefix search keeps the result set scoped to actual
          // session names instead of every transcript that mentions the
          // term. UUID inputs go through the dedicated session_id filter.
          nickname: isUuid ? undefined : trimmed,
          session_id: isUuid ? trimmed : undefined,
          limit: 8,
          sort: 'updated_at',
          order: 'desc',
        })
        if (cancelled) return
        // Drop sessions that are already visible in the sidebar — but keep
        // hidden ones so the user can re-pin a row they previously dismissed.
        const hidden = new Set(hiddenSessionIds)
        const visible = new Set([
          ...activeSessions.map(s => s.session_id).filter(id => !hidden.has(id)),
          ...pinnedSessions.map(p => p.session_id).filter(id => !hidden.has(id)),
        ])
        const fresh = (data.sessions || []).filter(s => !visible.has(s.session_id))
        setLookupResults(fresh.map(s => ({
          session_id: s.session_id,
          nickname: s.nickname,
          file_path: s.file_path,
          project_name: s.project?.name ?? null,
        })))
      } catch {
        if (!cancelled) setLookupResults([])
      } finally {
        if (!cancelled) setLookupLoading(false)
      }
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [lookupQuery, activeBackend, isCliBackend, activeSessions, pinnedSessions, hiddenSessionIds])

  const pinSession = (s: PinnedSession) => {
    if (!isCliBackend) return
    setPinnedSessions(prev => {
      if (prev.some(p => p.session_id === s.session_id)) return prev
      const next = [s, ...prev].slice(0, SIDEBAR_SESSION_CAP)
      writePinnedSessions(activeBackend, next)
      return next
    })
    // Unhide if the user previously dismissed this session.
    setHiddenSessionIds(prev => {
      if (!prev.includes(s.session_id)) return prev
      const next = prev.filter(id => id !== s.session_id)
      writeHiddenSessions(activeBackend, next)
      return next
    })
  }

  const hideSidebarSession = (sessionId: string) => {
    if (!isCliBackend) return
    setHiddenSessionIds(prev => {
      if (prev.includes(sessionId)) return prev
      const next = [...prev, sessionId]
      writeHiddenSessions(activeBackend, next)
      return next
    })
    setPinnedSessions(prev => {
      if (!prev.some(p => p.session_id === sessionId)) return prev
      const next = prev.filter(p => p.session_id !== sessionId)
      writePinnedSessions(activeBackend, next)
      return next
    })
    if (focusedActiveSession?.session_id === sessionId) setFocusedActiveSession(null)
  }

  // Active-session context menu state.
  const [sessionMenu, setSessionMenu] = useState<{
    sessionId: string
    position: { x: number; y: number }
  } | null>(null)

  const openSessionMenu = (e: MouseEvent, sessionId: string) => {
    e.preventDefault()
    setSessionMenu({ sessionId, position: { x: e.clientX, y: e.clientY } })
  }

  const handleSessionView = (sessionId: string) => {
    setLocation(`/sessions/${sessionId}`)
  }

  const handleSessionCopyResume = async (sessionId: string) => {
    const cmd = activeBackend === 'codex-cli'
      ? `codex resume ${sessionId}`
      : `claude --resume ${sessionId}`
    try {
      await navigator.clipboard.writeText(cmd)
      showToast('Resume command copied')
    } catch {
      showToast('Failed to copy')
    }
  }

  // Reorder via drag-and-drop. Captures the current visible order into
  // sidebarOrder on first move so unordered (newly active) sessions stop
  // floating around and stay where the user dropped them.
  const reorderSidebar = (draggedId: string, targetId: string) => {
    if (!isCliBackend || draggedId === targetId) return
    const visibleIds = sidebarSessions.map(s => s.session_id)
    const baseline = sidebarOrder.length > 0 ? [...sidebarOrder] : []
    for (const id of visibleIds) if (!baseline.includes(id)) baseline.push(id)
    const filtered = baseline.filter(id => id !== draggedId)
    const targetIdx = filtered.indexOf(targetId)
    if (targetIdx === -1) return
    filtered.splice(targetIdx, 0, draggedId)
    setSidebarOrder(filtered)
    writeSidebarOrder(activeBackend, filtered)
  }

  // Merged sidebar list: pinned rows first (manually added), then any active
  // rows that aren't already in the pinned list. Hidden ids drop from both.
  // Capped to SIDEBAR_SESSION_CAP so the list stays readable when the user
  // accumulates a lot of pinned/active sessions. User-customized order wins
  // over the default pinned-first / first_seen_at-asc layout.
  const sidebarSessions = useMemo(() => {
    if (!isCliBackend) return [] as Array<{
      session_id: string; nickname?: string | null;
      file_path?: string | null; project_name?: string | null; pinned: boolean
    }>
    const hidden = new Set(hiddenSessionIds)
    const sortedActive = [...activeSessions].sort((a, b) => {
      const aT = a.first_seen_at ? Date.parse(a.first_seen_at) : 0
      const bT = b.first_seen_at ? Date.parse(b.first_seen_at) : 0
      if (aT !== bT) return aT - bT
      return a.session_id.localeCompare(b.session_id)
    })
    const seen = new Set<string>()
    const out: Array<{
      session_id: string; nickname?: string | null;
      file_path?: string | null; project_name?: string | null; pinned: boolean
    }> = []
    for (const p of pinnedSessions) {
      if (hidden.has(p.session_id)) continue
      seen.add(p.session_id)
      out.push({
        session_id: p.session_id,
        nickname: p.nickname,
        file_path: p.file_path,
        project_name: p.project_name,
        pinned: true,
      })
    }
    for (const s of sortedActive) {
      if (hidden.has(s.session_id) || seen.has(s.session_id)) continue
      out.push({
        session_id: s.session_id,
        nickname: s.nickname,
        file_path: s.file_path,
        project_name: s.project?.name ?? null,
        pinned: false,
      })
    }
    if (sidebarOrder.length > 0) {
      const orderMap = new Map<string, number>()
      sidebarOrder.forEach((id, idx) => orderMap.set(id, idx))
      out.sort((a, b) => {
        const aOrder = orderMap.get(a.session_id)
        const bOrder = orderMap.get(b.session_id)
        if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder
        if (aOrder !== undefined) return -1
        if (bOrder !== undefined) return 1
        return 0
      })
    }
    return out.slice(0, SIDEBAR_SESSION_CAP)
  }, [pinnedSessions, hiddenSessionIds, activeSessions, isCliBackend, sidebarOrder])

  const startNewChat = (backend: Backend) => {
    setNewChatBackend(backend)
    setSelectedModel(getDefaultModel(backend))
    setLocation('/chat/new')
  }

  // Load chat when id changes
  useEffect(() => {
    if (!id) {
      setMessages([])
      setDelegations({})
      setCurrentChatId(null)
      setChatLoading(false)
      setRenderedHtml({})
      return
    }

    // Skip re-fetch when we just sent a message and already have fresh data
    // (e.g. after setLocation on new chat creation)
    if (skipNextFetchRef.current) {
      skipNextFetchRef.current = false
      return
    }

    let cancelled = false
    setChatLoading(true)
    setRenderedHtml({})
    getChatById(id, true)
      .then(res => {
        if (cancelled) return
        setMessages(res.chat.messages || [])
        setDelegations(res.chat.delegations || {})
        setCurrentChatId(res.chat.id)
        const backend = res.chat.assistant_handle as Backend
        setCurrentBackend(backend)
        setCurrentSource(res.chat.source || 'ui')
        setCurrentCaller(res.chat.caller_handle || null)
        setSelectedModel(getDefaultModel(backend))
      })
      .catch(err => {
        if (!cancelled) showToast(err.message || 'Failed to load chat')
      })
      .finally(() => {
        if (!cancelled) setChatLoading(false)
      })
    return () => { cancelled = true }
  }, [id])

  // Render markdown for assistant responses
  useEffect(() => {
    const delegatedMessages = Object.values(delegations).flat().flatMap(d => d.messages || [])
    const toRender = [...messages, ...delegatedMessages].filter(m => m.response && !renderedHtml[m.id])
    if (toRender.length === 0) return
    let cancelled = false
    Promise.all(
      toRender.map(async m => {
        const html = await renderMarkdown(m.response!)
        return { id: m.id, html }
      })
    ).then(results => {
      if (cancelled) return
      setRenderedHtml(prev => {
        const next = { ...prev }
        for (const r of results) next[r.id] = r.html
        return next
      })
    })
    return () => { cancelled = true }
  }, [messages, delegations])

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isSending])

  // Auto-resize textarea
  const handleInput = (e: Event) => {
    const target = e.target as HTMLTextAreaElement
    setPrompt(target.value)
    target.style.height = 'auto'
    target.style.height = Math.min(target.scrollHeight, 200) + 'px'
  }

  // Stop in-flight request
  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
  }, [])

  // Send message
  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || isSending) return

    const backend = currentChatId ? currentBackend : newChatBackend
    const controller = new AbortController()
    abortRef.current = controller

    setPrompt('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setIsSending(true)

    // Optimistic: add user message immediately so the user sees it
    const tempUserMsg: AssistantChatMessage = {
      id: `temp-${Date.now()}`,
      chat_id: currentChatId || '',
      prompt_text: trimmed,
      response: null,
      response_parts: null,
      model: '',
      input_tokens: null,
      output_tokens: null,
      error: null,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    setMessages(prev => [...prev, tempUserMsg])

    let requestSent = false

    try {
      // Grace period before posting — gives user a window to cancel (Esc or Stop)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 1500)
        controller.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })

      requestSent = true
      const body: import('../types').SendChatBody = {
        prompt_text: trimmed,
        model: selectedModel,
      }
      if (currentChatId) body.chat_id = currentChatId

      // Gemini-specific options
      if (backend === 'gemini') {
        if (geminiOptions.useThinking) {
          body.use_thinking = true
          body.thinking_budget = geminiOptions.thinkingBudget
        }
        if (geminiOptions.useGoogleSearch) {
          body.use_google_search = true
        }
        if (geminiOptions.systemPrompt.trim()) {
          body.system_prompt = geminiOptions.systemPrompt.trim()
        }
      }

      const res: SendChatResponse = await sendChatMessage(backend, body, controller.signal)

      // New chat — update URL and state
      if (!currentChatId && res.chat_id) {
        setCurrentChatId(res.chat_id)
        setCurrentBackend(backend)
        skipNextFetchRef.current = true
        setLocation(`/chat/${res.chat_id}`, { replace: true })
      }

      // Replace temp message with real one
      setMessages(prev => {
        const withoutTemp = prev.filter(m => m.id !== tempUserMsg.id)
        return [...withoutTemp, res.message]
      })

      // Refresh sidebar so new/updated chat appears at top
      refreshChatList()
    } catch (err: any) {
      // User cancelled
      if (controller.signal.aborted) {
        if (!requestSent) {
          // True cancel — request never left, restore prompt for editing
          setMessages(prev => prev.filter(m => m.id !== tempUserMsg.id))
          setPrompt(trimmed)
          showToast('Message cancelled')
        } else {
          // Late stop — request was already sent, backend may complete it.
          // Re-fetch to show actual server state.
          showToast('Stopped — response may still arrive')
          if (currentChatId) {
            getChatById(currentChatId, true)
              .then(res => {
                setMessages(res.chat.messages || [])
                setDelegations(res.chat.delegations || {})
              })
              .catch(() => {})
          }
          refreshChatList()
        }
        return
      }

      // Backend errors (e.g. codex failure) return 500 but still persist the chat + message.
      // Try to extract the persisted data from the error response body.
      let recovered = false
      if (err?.response) {
        try {
          const body = await err.response.json()
          if (body.chat_id && body.message) {
            // Chat was created and message was persisted (with error field set)
            if (!currentChatId) {
              setCurrentChatId(body.chat_id)
              setCurrentBackend(backend)
              skipNextFetchRef.current = true
              setLocation(`/chat/${body.chat_id}`, { replace: true })
            }
            setMessages(prev => {
              const withoutTemp = prev.filter(m => m.id !== tempUserMsg.id)
              return [...withoutTemp, body.message]
            })
            refreshChatList()
            recovered = true
          }
        } catch { /* couldn't parse body, fall through */ }
      }
      if (!recovered) {
        setMessages(prev => prev.filter(m => m.id !== tempUserMsg.id))
        showToast(err instanceof Error ? err.message : 'Failed to send message')
      }
    } finally {
      abortRef.current = null
      setIsSending(false)
    }
  }, [currentChatId, currentBackend, newChatBackend, selectedModel, isSending, geminiOptions, refreshChatList])

  const handleSubmit = () => sendMessage(prompt)

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && isSending) {
      e.preventDefault()
      handleStop()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleCopy = (text: string, msgId: string) => {
    navigator.clipboard.writeText(text)
    setCopiedId(msgId)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const handleDeleteChat = async () => {
    if (!currentChatId) return
    try {
      await deleteChatById(currentChatId)
      showToast('Chat deleted')
      setChatList(prev => prev.filter(c => c.id !== currentChatId))
      setLocation('/chat')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete')
    }
    setShowDeleteConfirm(false)
  }

  const handleDeleteAllChats = async () => {
    try {
      await deleteAllChats()
      showToast('All chats deleted')
      setChatList([])
      setMessages([])
      setDelegations({})
      setLocation('/chat')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete chats')
    }
    setShowDeleteAllConfirm(false)
  }

  const handleDeleteMessage = async () => {
    if (!currentChatId || !deleteMessageTarget) return
    try {
      await deleteChatMessageById(currentChatId, deleteMessageTarget)
      setMessages(prev => prev.filter(m => m.id !== deleteMessageTarget))
      showToast('Message deleted')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete message')
    }
    setDeleteMessageTarget(null)
  }

  // Determine display state
  const hasActiveChat = !!id || isNew || messages.length > 0 || isSending
  const activeBackendLabel = currentChatId
    ? BACKEND_LABELS[currentBackend]
    : isNew
      ? BACKEND_LABELS[newChatBackend]
      : null

  return (
    <>
    {isDesktopApp() && <div class={styles.footerSpacer} />}
    <div class={`${styles.layout} ${sidebarCollapsed ? styles.sidebarCollapsed : ''}`}>
      {/* ===== Chat sidebar ===== */}
      <div class={styles.sidebar}>
        <div class={styles.filterRow}>
          {FILTER_BACKENDS.map(backend => (
            <button
              key={backend}
              class={`${styles.filterPill} ${backendFilter === backend ? `${styles.filterPillActive} ${BACKEND_PILL_CLASS[backend]}` : ''}`}
              onClick={() => {
                const isCliBackend = backend === 'claude-code' || backend === 'codex-cli'
                if (backendFilter === backend && !isCliBackend) {
                  // Gemini keeps the toggle-off-to-show-all behavior since
                  // its surface is a structured chat list.
                  setBackendFilter('all')
                  return
                }
                autoSelectRef.current = true
                setBackendFilter(backend)
                setNewChatBackend(backend)
                // For PTY backends, drop any chat-id from the URL so the
                // surface aligns with the clicked pill instead of staying
                // tied to a saved chat from another assistant.
                if (isCliBackend) {
                  setLocation('/chat')
                }
              }}
            >
              {BACKEND_LABELS[backend]}
            </button>
          ))}
          <span class={styles.filterSpacer} />
          {activeBackend === 'gemini' && (
            <button
              class={styles.newChatBtn}
              onClick={() => startNewChat(newChatBackend)}
              title="New chat"
            >
              <Pencil size={14} />
            </button>
          )}
        </div>

        {activeBackend === 'claude-code' || activeBackend === 'codex-cli' ? (
          <>
            <div class={styles.sessionLookup}>
              <Search size={14} class={styles.sessionLookupIcon} />
              <input
                type="text"
                class={styles.sessionLookupInput}
                placeholder="Find session by name or UUID"
                value={lookupQuery}
                onInput={(e) => setLookupQuery((e.target as HTMLInputElement).value)}
                onFocus={() => setLookupOpen(true)}
                onBlur={() => setTimeout(() => setLookupOpen(false), 150)}
              />
              {lookupQuery && (
                <button
                  type="button"
                  class={styles.sessionLookupClear}
                  onClick={() => { setLookupQuery(''); setLookupResults([]) }}
                  title="Clear"
                >
                  <X size={12} />
                </button>
              )}
              {lookupOpen && lookupQuery.trim() && (
                <div class={styles.sessionLookupResults}>
                  {lookupLoading ? (
                    <div class={styles.sessionLookupEmpty}><Loader2 size={14} class="spin" /></div>
                  ) : lookupResults.length === 0 ? (
                    <div class={styles.sessionLookupEmpty}>No matches</div>
                  ) : (
                    lookupResults.map(r => (
                      <button
                        key={r.session_id}
                        type="button"
                        class={styles.sessionLookupResult}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          pinSession(r)
                          setFocusedActiveSession({
                            session_id: r.session_id,
                            file_path: r.file_path ?? null,
                            nickname: r.nickname,
                            project_name: r.project_name,
                          })
                          setLookupQuery('')
                          setLookupResults([])
                          setLookupOpen(false)
                        }}
                      >
                        <span class={styles.sessionLookupResultTitle}>
                          {r.nickname || r.session_id.slice(0, 8)}
                        </span>
                        {r.project_name && (
                          <span class={styles.sessionLookupResultMeta}>{r.project_name}</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <div class={styles.chatList}>
              {sidebarSessions.length === 0 ? (
                <div class={styles.sidebarEmpty}>No active sessions</div>
              ) : (
                sidebarSessions.map(s => (
                  <button
                    key={s.session_id}
                    class={[
                      styles.chatRow,
                      focusedActiveSession?.session_id === s.session_id ? styles.active : '',
                      draggingId === s.session_id ? styles.chatRowDragging : '',
                      dragOverId === s.session_id ? styles.chatRowDropTarget : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => setFocusedActiveSession({
                      session_id: s.session_id,
                      file_path: s.file_path ?? null,
                      nickname: s.nickname,
                      project_name: s.project_name,
                    })}
                    onContextMenu={(e: MouseEvent) => openSessionMenu(e, s.session_id)}
                    type="button"
                    draggable={true}
                    onDragStart={(e: DragEvent) => {
                      setDraggingId(s.session_id)
                      if (e.dataTransfer) {
                        e.dataTransfer.setData('text/plain', s.session_id)
                        e.dataTransfer.effectAllowed = 'move'
                      }
                    }}
                    onDragEnter={() => {
                      if (draggingId && draggingId !== s.session_id) setDragOverId(s.session_id)
                    }}
                    onDragOver={(e: DragEvent) => {
                      if (draggingId && draggingId !== s.session_id) {
                        e.preventDefault()
                        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
                      }
                    }}
                    onDragLeave={() => {
                      if (dragOverId === s.session_id) setDragOverId(null)
                    }}
                    onDrop={(e: DragEvent) => {
                      e.preventDefault()
                      const dragged = e.dataTransfer?.getData('text/plain') || draggingId
                      if (dragged && dragged !== s.session_id) reorderSidebar(dragged, s.session_id)
                      setDraggingId(null)
                      setDragOverId(null)
                    }}
                    onDragEnd={() => { setDraggingId(null); setDragOverId(null) }}
                  >
                    <span class={styles.chatRowTitle}>
                      {s.nickname || s.session_id.slice(0, 8)}
                    </span>
                    {s.project_name && (
                      <span class={styles.chatRowMeta}>{s.project_name}</span>
                    )}
                  </button>
                ))
              )}
            </div>
          </>
        ) : (<>
        <div class={styles.sourceFilter}>
          <button
            class={`${styles.sourceTab} ${sourceFilter === 'ui' ? styles.sourceTabActive : ''}`}
            onClick={() => setSourceFilter('ui')}
          >
            My chats
          </button>
          <button
            class={`${styles.sourceTab} ${sourceFilter === 'mcp' ? styles.sourceTabActive : ''}`}
            onClick={() => setSourceFilter('mcp')}
          >
            MCP
          </button>
        </div>

        <div class={styles.chatList}>
          {listLoading && chatList.length === 0 ? (
            <div class={styles.sidebarLoading}>
              <Loader2 size={18} class="spin" />
            </div>
          ) : chatList.length === 0 ? (
            <div class={styles.sidebarEmpty}>No conversations yet</div>
          ) : (
            chatList.map(chat => (
              renamingChatId === chat.id ? (
                <div key={chat.id} class={styles.renameRow}>
                  <input
                    ref={renameInputRef}
                    class={styles.renameInput}
                    value={renameValue}
                    onInput={e => setRenameValue((e.target as HTMLInputElement).value)}
                    onKeyDown={handleRenameKeyDown}
                  />
                  <div class={styles.renameActions}>
                    <button class={styles.renameBtn} onClick={handleRenameSave}>Save</button>
                    <button class={styles.renameBtnCancel} onClick={handleRenameCancel}>Cancel</button>
                  </div>
                </div>
              ) : (
                <Link
                  key={chat.id}
                  href={`/chat/${chat.id}`}
                  class={`${styles.chatRow} ${id === chat.id ? styles.active : ''}`}
                  onContextMenu={(e: MouseEvent) => handleContextMenu(e, chat)}
                >
                  <span class={styles.chatRowTitle}>
                    {chat.title || 'Untitled chat'}
                  </span>
                  <span class={`${styles.chatRowBadge} ${BACKEND_BADGE_CLASS[chat.assistant_handle as Backend] || ''}`}>
                    {BACKEND_LABELS[chat.assistant_handle as Backend] || chat.assistant_handle}
                  </span>
                </Link>
              )
            ))
          )}
        </div>

        {chatList.length > 0 && (
          <div class={styles.sidebarFooter}>
            <button
              class={styles.deleteAllBtn}
              onClick={() => setShowDeleteAllConfirm(true)}
            >
              <Trash2 size={14} />
              Delete all chats
            </button>
          </div>
        )}
        </>)}
      </div>

      {/* ===== Main chat area ===== */}
      <div class={styles.chatMain}>
        {/* Sticky header */}
        <div class={styles.chatHeader}>
          <div class={styles.chatHeaderLeft}>
            <button
              class={styles.headerBtn}
              onClick={toggleSidebar}
              title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            >
              {sidebarCollapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
            </button>
            {activeBackendLabel && (
              <span class={styles.chatHeaderLabel}>{activeBackendLabel}</span>
            )}
            {focusedActiveSession && (
              <span class={styles.chatHeaderProject}>
                {focusedActiveSession.project_name || '—'}
              </span>
            )}
          </div>
          <div class={styles.chatHeaderRight}>
            {currentChatId && (
              <button
                class={styles.headerBtn}
                onClick={() => setShowDeleteConfirm(true)}
                title="Delete chat"
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
        </div>

        {activeBackend === 'claude-code' || activeBackend === 'codex-cli' ? (
          <div class={styles.terminalWrap}>
            {focusedActiveSession ? (
              // Resume mode — cwd is read from the session JSONL, so the
              // picker is irrelevant. Show the focused session's identity
              // and a button to drop back to fresh-spawn.
              <div class={styles.cwdRow}>
                <label class={styles.cwdLabel}>session</label>
                <span class={styles.sessionPin}>
                  {focusedActiveSession.nickname || focusedActiveSession.session_id.slice(0, 8)}
                </span>
                {focusedActiveSession.project_name && (
                  <span class={styles.cwdHint}>{focusedActiveSession.project_name}</span>
                )}
                <span class={styles.cwdSpacer} />
                <button
                  type="button"
                  class={styles.cwdInlineBtn}
                  onClick={() => setFocusedActiveSession(null)}
                  title="Stop watching this session and return to fresh-spawn"
                >
                  New PTY
                </button>
              </div>
            ) : (
              <div class={styles.cwdRow}>
                <label class={styles.cwdLabel}>cwd</label>
                <input
                  class={styles.cwdInput}
                  type="text"
                  value={terminalCwd}
                  onInput={e => setTerminalCwd((e.target as HTMLInputElement).value)}
                  placeholder="$HOME"
                  spellcheck={false}
                />
                {ptyProjects.length > 0 && (
                  <select
                    class={styles.cwdSelect}
                    value=""
                    onChange={e => {
                      const path = (e.target as HTMLSelectElement).value
                      if (path) setTerminalCwd(path)
                      ;(e.target as HTMLSelectElement).value = ''
                    }}
                    title="Pick a khef project as cwd"
                  >
                    <option value="">project…</option>
                    {ptyProjects.map(p => (
                      <option key={p.id} value={p.path || ''}>
                        {p.display_name || p.name}
                      </option>
                    ))}
                  </select>
                )}
                <span class={styles.cwdHint}>Applied on next Connect</span>
              </div>
            )}
            <SessionTerminal
              cmd={activeBackend === 'codex-cli' ? 'codex' : 'claude'}
              cwd={focusedActiveSession ? null : (terminalCwd || null)}
              sessionId={focusedActiveSession?.session_id || null}
              filePath={focusedActiveSession?.file_path || null}
            />
          </div>
        ) : (<>
        {/* Messages */}
        <div class={styles.messagesArea}>
          <div class={styles.messagesInner}>
            {chatLoading ? (
              <div class={styles.emptyState}>
                <Loader2 size={24} class="spin" />
              </div>
            ) : !hasActiveChat ? (
              <div class={styles.emptyState}>
                <MessageSquare size={32} />
                <div class={styles.emptyTitle}>Khef Chat</div>
                <div class={styles.emptySubtitle}>
                  Start a new conversation or select one from the sidebar
                </div>
              </div>
            ) : messages.length === 0 && !isSending ? (
              <div class={styles.emptyState}>
                <MessageSquare size={32} />
                <div class={styles.emptyTitle}>Start a conversation</div>
                <div class={styles.emptySubtitle}>
                  {newChatBackend === 'claude-code'
                    ? 'Claude has access to khef memories, search, and pipelines'
                    : newChatBackend === 'codex-cli'
                      ? 'Codex for fast, code-focused responses via OpenAI'
                      : 'Gemini for general-purpose conversation'}
                </div>
              </div>
            ) : (
              <>
                {messages.map(msg => (
                  <div key={msg.id}>
                    {/* User message */}
                    <div class={styles.messageBlock}>
                      <div class={styles.messageAuthor}>{currentSource === 'mcp' ? (currentCaller ? formatAssistantName(currentCaller) : 'MCP') : 'You'}</div>
                      <div class={styles.userContent}>{msg.prompt_text}</div>
                    </div>

                    {/* Assistant response */}
                    {(msg.response || msg.response_parts) && (
                      <div class={styles.messageBlock} style={{ marginTop: 'var(--space-4)' }}>
                        <div class={styles.messageAuthor}>
                          {BACKEND_LABELS[currentBackend] || 'Assistant'}
                        </div>
                        <div
                          class={styles.assistantContent}
                          dangerouslySetInnerHTML={{ __html: renderedHtml[msg.id] || msg.response || '' }}
                        />
                        <div class={styles.messageActions}>
                          <button
                            class={styles.actionBtn}
                            onClick={() => handleCopy(msg.response!, msg.id)}
                          >
                            {copiedId === msg.id
                              ? <><Check size={12} /> Copied</>
                              : <><Copy size={12} /> Copy</>
                            }
                          </button>
                          {!msg.id.startsWith('temp-') && (
                            <button
                              class={styles.actionBtnDanger}
                              onClick={() => setDeleteMessageTarget(msg.id)}
                              title="Delete message"
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {(delegations[msg.id] || []).map(delegation => (
                      <details key={delegation.chat.id} class={styles.delegatedBlock}>
                        <summary class={styles.delegatedSummary}>
                          Delegated to {BACKEND_LABELS[delegation.delegated_handle as Backend] || delegation.delegated_handle}
                        </summary>
                        <div class={styles.delegatedContent}>
                          {delegation.messages.map(childMessage => (
                            <div key={childMessage.id} class={styles.delegatedExchange}>
                              <div class={styles.delegatedPrompt}>
                                <span class={styles.delegatedLabel}>
                                  {formatAssistantName(currentBackend)} asked{msg.model ? ` (${msg.model})` : ''}:
                                </span>
                                <div class={styles.delegatedText}>{childMessage.prompt_text}</div>
                              </div>
                              {childMessage.response && (
                                <div class={styles.delegatedResponse}>
                                  <span class={styles.delegatedLabel}>
                                    {formatAssistantName(delegation.delegated_handle)} responded{childMessage.model ? ` (${childMessage.model})` : ''}:
                                  </span>
                                  <div
                                    class={styles.delegatedText}
                                    dangerouslySetInnerHTML={{
                                      __html: renderedHtml[childMessage.id] || childMessage.response || '',
                                    }}
                                  />
                                </div>
                              )}
                              {childMessage.error && (
                                <div class={styles.messageError}>{childMessage.error}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    ))}

                    {msg.error && (
                      <div class={styles.messageError}>{msg.error}</div>
                    )}

                    {msg.error && !msg.response && !msg.response_parts && !msg.id.startsWith('temp-') && (
                      <div class={styles.messageActions}>
                        <button
                          class={styles.actionBtnDanger}
                          onClick={() => setDeleteMessageTarget(msg.id)}
                          title="Delete message"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                ))}

                {isSending && (
                  <div class={styles.messageBlock}>
                    <div class={styles.messageAuthor}>
                      {BACKEND_LABELS[currentChatId ? currentBackend : newChatBackend] || 'Assistant'}
                    </div>
                    <div class={styles.loadingDots}>
                      <span /><span /><span />
                    </div>
                  </div>
                )}
              </>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Floating input bar */}
        <div class={styles.inputBar}>
          <div class={styles.inputBarInner}>
            <textarea
              ref={textareaRef}
              class={styles.inputTextarea}
              value={prompt}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything..."
              disabled={isSending}
              rows={1}
            />
            {activeBackend === 'gemini' && (
              <GeminiChatOptions
                options={geminiOptions}
                onChange={setGeminiOptions}
                disabled={isSending}
              />
            )}
            <div class={styles.inputControls}>
              <div class={styles.inputControlsLeft}>
                <select
                  class={styles.modelSelect}
                  value={selectedModel}
                  onChange={e => setSelectedModel((e.target as HTMLSelectElement).value)}
                >
                  {availableModels.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              {isSending ? (
                <button
                  class={`${styles.sendBtn} ${styles.stopBtn}`}
                  onClick={handleStop}
                  title="Stop (Esc)"
                >
                  <Square size={14} />
                </button>
              ) : (
                <button
                  class={styles.sendBtn}
                  onClick={handleSubmit}
                  disabled={!prompt.trim()}
                  title="Send (Enter)"
                >
                  <Send size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
        </>)}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <ConversationContextMenu
          conversationId={contextMenu.chat.id}
          position={contextMenu.position}
          onDelete={handleContextDelete}
          onRename={handleContextRename}
          onClose={() => setContextMenu(null)}
          onShowToast={showToast}
        />
      )}

      {/* Sidebar session context menu */}
      {sessionMenu && (
        <SessionContextMenu
          sessionId={sessionMenu.sessionId}
          position={sessionMenu.position}
          onClose={() => setSessionMenu(null)}
          onShowToast={showToast}
          onOpen={handleSessionView}
          onCopyResume={handleSessionCopyResume}
          onRemove={hideSidebarSession}
        />
      )}

      {/* Delete chat confirmation modal */}
      {showDeleteConfirm && (
        <ConfirmModal
          title="Delete chat?"
          message="This will permanently delete this conversation and all its messages."
          confirmLabel="Delete"
          onConfirm={handleDeleteChat}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {/* Delete all chats confirmation modal */}
      {showDeleteAllConfirm && (
        <ConfirmModal
          title="Delete all chats?"
          message={`This will permanently delete all ${chatList.length} conversation${chatList.length === 1 ? '' : 's'} and their messages.`}
          confirmLabel="Delete all"
          onConfirm={handleDeleteAllChats}
          onCancel={() => setShowDeleteAllConfirm(false)}
        />
      )}

      {/* Delete message confirmation modal */}
      {deleteMessageTarget && (
        <ConfirmModal
          title="Delete message?"
          message="This will permanently delete this message and its response."
          confirmLabel="Delete"
          onConfirm={handleDeleteMessage}
          onCancel={() => setDeleteMessageTarget(null)}
        />
      )}
    </div>
    </>
  )
}
