import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks'
import { memo } from 'preact/compat'
import { Link, useLocation } from 'wouter-preact'
import {
  Users, Radio, Clock, FileText, Play, User, Bot, Code, ChevronRight,
  Trash2, Plus, ArrowLeft, ExternalLink, Copy
} from 'lucide-preact'
import clsx from 'clsx'
import {
  getSessionTeam, getSession, deleteSessionTeam, removeTeamMember,
  addTeamMembers, reorderTeamMembers, broadcastToTeam, sendLiveMessage, triggerSessionSync,
  getSessions, updateSessionTeam, getActiveSessions, getSessionTranscript,
} from '../lib/api'
import type { SessionTeam, SessionTeamMember } from '../lib/api'
import type { SessionDetail, SessionChunk, SessionEntry, SessionContentBlock } from '../types'
import { formatRelativeTime } from '../lib/format'
import { ArchiveBadge, ChatInput, SessionToolbar } from '../components/session'
import type { ViewMode } from '../components/session'
import { LoadingMessage, ConfirmModal, useToast, VirtualList } from '../components/ui'
import { useLiveUpdates } from '../hooks/useLiveUpdates'
import { useDocumentTitle } from '../hooks'
import styles from './TeamBoardPage.module.css'

interface TeamBoardPageProps {
  id: string
}

type SegmentRole = 'user' | 'assistant' | 'thinking' | 'tool_use'

interface ParsedSegment {
  role: SegmentRole
  content: string
  toolName?: string
}

const TOOL_MARKER_RE = /^\[Tool: ([^\]]+)\] ?(.*)$/

interface SessionCardProps {
  member: SessionTeamMember
  idx: number
  isSelected: boolean
  isDragging: boolean
  isDropTarget: boolean
  isReordering: boolean
  onSelect: (sessionId: string) => void
  onOpenContextMenu: (member: SessionTeamMember, e: MouseEvent) => void
  onDragStart: (idx: number) => void
  onDragOver: (idx: number, e: DragEvent) => void
  onDragLeave: (idx: number) => void
  onDrop: (idx: number) => void
  onDragEnd: () => void
}


function parseChunkContent(content: string): ParsedSegment[] {
  const segments: ParsedSegment[] = []
  const lines = content.split('\n')
  let currentRole: SegmentRole | null = null
  let currentContent: string[] = []
  let currentToolName: string | undefined

  const flush = () => {
    if (currentRole && currentContent.length > 0) {
      const seg: ParsedSegment = { role: currentRole, content: currentContent.join('\n') }
      if (currentRole === 'tool_use' && currentToolName) seg.toolName = currentToolName
      segments.push(seg)
    }
    currentContent = []
    currentToolName = undefined
  }

  for (const line of lines) {
    const toolMatch = line.match(TOOL_MARKER_RE)
    if (toolMatch) {
      flush()
      currentRole = 'tool_use'
      currentToolName = toolMatch[1]
      currentContent = [toolMatch[2]]
      continue
    }
    if (line.startsWith('User: ')) {
      flush()
      currentRole = 'user'
      currentContent = [line.slice(6)]
    } else if (line.startsWith('Assistant: ') || line.startsWith('A: ')) {
      flush()
      const prefix = line.startsWith('Assistant: ') ? 'Assistant: ' : 'A: '
      const text = line.slice(prefix.length)
      if (text.startsWith('[Thinking]')) {
        currentRole = 'thinking'
        currentContent = [text.slice(10).trim()]
      } else {
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
      currentContent.push(line)
    }
  }

  flush()
  return segments
}

function getRawEntryKey(entry: SessionEntry, fallbackIndex: number): string {
  return entry.uuid || entry.leafUuid || entry.timestamp || `${entry.type}-${fallbackIndex}`
}

function getRawBlockKey(entry: SessionEntry, entryIndex: number, block: SessionContentBlock, blockIndex: number): string {
  const entryKey = getRawEntryKey(entry, entryIndex)
  return `${entryKey}:${block.type}:${block.tool_use_id || block.name || blockIndex}`
}

const SessionCard = memo(function SessionCard({
  member,
  idx,
  isSelected,
  isDragging,
  isDropTarget,
  isReordering,
  onSelect,
  onOpenContextMenu,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: SessionCardProps) {
  return (
    <div
      class={clsx(
        styles.sessionCard,
        isSelected && styles.sessionCardSelected,
        isDragging && styles.sessionCardDragging,
        isDropTarget && styles.sessionCardDropTarget,
      )}
      onClick={() => onSelect(member.session_id)}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault()
        onOpenContextMenu(member, e)
      }}
      draggable={!isReordering}
      onDragStart={() => onDragStart(idx)}
      onDragOver={(e: DragEvent) => onDragOver(idx, e)}
      onDragLeave={() => onDragLeave(idx)}
      onDrop={() => onDrop(idx)}
      onDragEnd={onDragEnd}
    >
      <div class={styles.sessionCardHeader}>
        <span class={`${styles.statusDot} ${styles[member.status || 'inactive']}`} />
        <span class={styles.sessionNickname}>{member.nickname || member.session_id.slice(0, 8)}</span>
        {member.project_handle && (
          <span class={styles.projectBadge}>{member.project_handle}</span>
        )}
      </div>
      {member.summary && (
        <div class={styles.sessionSummary}>{member.summary}</div>
      )}
      <div class={styles.sessionMeta}>
        {member.message_count && (
          <span><FileText size={10} /> {member.message_count} msgs</span>
        )}
        {member.last_seen_at && (
          <span><Clock size={10} /> {formatRelativeTime(member.last_seen_at)}</span>
        )}
        {member.status === 'active' && member.context_window_tokens != null && (
          <span class={styles.contextInfo}>
            {Math.round(member.context_window_tokens / 1000)}k ctx
          </span>
        )}
      </div>
    </div>
  )
})


export function TeamBoardPage({ id }: TeamBoardPageProps) {
  const { showToast } = useToast()
  const [, setLocation] = useLocation()
  const [team, setTeam] = useState<SessionTeam | null>(null)
  const [members, setMembers] = useState<SessionTeamMember[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useDocumentTitle(team?.name ? `Team - ${team.name}` : 'Team - Loading')

  // Focused session
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null)
  const [focusedSession, setFocusedSession] = useState<SessionDetail | null>(null)
  const [focusedChunks, setFocusedChunks] = useState<SessionChunk[]>([])
  const [focusLoading, setFocusLoading] = useState(false)
  const [showUser, setShowUser] = useState(true)
  const [showAssistant, setShowAssistant] = useState(true)
  const [showThinking, setShowThinking] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc')
  const [viewMode, setViewMode] = useState<ViewMode>('parsed')
  const [rawEntries, setRawEntries] = useState<SessionEntry[]>([])
  const [rawSource, setRawSource] = useState<'original' | 'backup' | undefined>(undefined)
  const [rawFilePath, setRawFilePath] = useState<string | undefined>(undefined)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawTotalCount, setRawTotalCount] = useState(0)
  const [toggledBlocks, setToggledBlocks] = useState<Set<string>>(new Set())
  const [allExpanded, setAllExpanded] = useState<boolean | null>(true)
  const [showTools, setShowTools] = useState(true)
  const [showCommandsOnly, setShowCommandsOnly] = useState(false)
  const [showBashOnly, setShowBashOnly] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const conversationRef = useRef<HTMLDivElement>(null)

  // Broadcast mode
  const [broadcastMode, setBroadcastMode] = useState(false)
  const [isBroadcasting, setIsBroadcasting] = useState(false)

  // Add session modal
  const [showAddModal, setShowAddModal] = useState(false)
  const [addSearch, setAddSearch] = useState('')
  const [addResults, setAddResults] = useState<SessionDetail[]>([])
  const [addLoading, setAddLoading] = useState(false)

  // Delete confirm
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Edit team name
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')

  // Drag reorder
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [isReordering, setIsReordering] = useState(false)
  const isDragging = dragIdx !== null

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ member: SessionTeamMember; position: { x: number; y: number } } | null>(null)

  // Load team
  const loadTeam = useCallback(async () => {
    try {
      const data = await getSessionTeam(id)
      setTeam(data.team)
      setMembers(data.members)
    } catch (err: any) {
      setError(err.message || 'Failed to load team')
    } finally {
      setIsLoading(false)
    }
  }, [id])

  useEffect(() => { loadTeam() }, [loadTeam])

  // Auto-select first session on initial load
  useEffect(() => {
    if (members.length > 0 && !focusedSessionId) {
      setFocusedSessionId(members[0].session_id)
    }
  }, [members, focusedSessionId])

  // Poll team members for status updates (pause during drag)
  useEffect(() => {
    if (!team || isDragging) return
    const poll = setInterval(loadTeam, 15_000)
    return () => clearInterval(poll)
  }, [team?.id, loadTeam, isDragging])

  // Load focused session
  useEffect(() => {
    if (!focusedSessionId) {
      setFocusedSession(null)
      setFocusedChunks([])
      return
    }

    let mounted = true
    setFocusLoading(true)

    async function load() {
      try {
        // Try to find the session by session_id (file UUID)
        const response = await getSession(focusedSessionId!)
        if (!mounted) return
        setFocusedSession(response.session)
        setFocusedChunks(response.chunks || [])
      } catch {
        if (mounted) {
          setFocusedSession(null)
          setFocusedChunks([])
        }
      } finally {
        if (mounted) setFocusLoading(false)
      }
    }

    load()
    return () => { mounted = false }
  }, [focusedSessionId])

  // Auto-refresh focused session if active
  useEffect(() => {
    const member = members.find(m => m.session_id === focusedSessionId)
    if (!member || member.status !== 'active' || !focusedSessionId) return

    const poll = setInterval(async () => {
      try {
        await triggerSessionSync()
        const response = await getSession(focusedSessionId!)
        setFocusedSession(response.session)
        setFocusedChunks(response.chunks || [])
      } catch {}
    }, 10_000)

    return () => clearInterval(poll)
  }, [focusedSessionId, members])

  // Derive project dir from focused session file path
  const rawProjectDir = useMemo(() => {
    if (!focusedSession?.file_path) return ''
    return focusedSession.file_path.split('/projects/')[1]?.split('/')[0] || ''
  }, [focusedSession?.file_path])

  // Load raw entries when view mode switches to raw — loads newest entries first
  useEffect(() => {
    if (viewMode !== 'raw' || !focusedSession?.session_id || !rawProjectDir) return
    let mounted = true
    setRawLoading(true)
    setRawEntries([])
    setRawTotalCount(0)
    const RAW_PAGE_SIZE = 500

    getSessionTranscript('claude-code', rawProjectDir, focusedSession.session_id, { limit: 1, offset: 0 })
      .then(meta => {
        if (!mounted) return
        const total = meta.pagination?.total_count ?? 0
        setRawTotalCount(total)
        if (total === 0) return
        const offset = Math.max(0, total - RAW_PAGE_SIZE)
        return getSessionTranscript('claude-code', rawProjectDir, focusedSession.session_id, { limit: RAW_PAGE_SIZE, offset })
          .then(data => {
            if (!mounted) return
            setRawEntries(data.session?.entries || [])
            setRawSource(data.session?.source)
            setRawFilePath(data.session?.file_path)
          })
      })
      .catch(() => {})
      .finally(() => { if (mounted) setRawLoading(false) })
    return () => { mounted = false }
  }, [viewMode, focusedSession?.session_id, rawProjectDir])

  // Refresh raw entries tail — append new entries that appeared since last load.
  // Triggered by SSE `session.updated` deltas so the Raw view stays live like Parsed.
  const refreshRawTail = useCallback(async () => {
    if (viewMode !== 'raw' || !rawProjectDir || !focusedSession?.session_id) return
    if (rawLoading) return
    try {
      const meta = await getSessionTranscript('claude-code', rawProjectDir, focusedSession.session_id, { limit: 1, offset: 0 })
      const newTotal = meta.pagination?.total_count ?? 0
      if (newTotal <= rawTotalCount) return
      const delta = newTotal - rawTotalCount
      const data = await getSessionTranscript('claude-code', rawProjectDir, focusedSession.session_id, { limit: delta, offset: rawTotalCount })
      const newer = data.session?.entries || []
      if (newer.length === 0) return
      setRawEntries(prev => [...prev, ...newer])
      setRawTotalCount(newTotal)
    } catch {
      // Silent — next delta or manual refresh will retry
    }
  }, [viewMode, rawProjectDir, focusedSession?.session_id, rawTotalCount, rawLoading])

  // Live updates: patch member cards from sessions:active and refetch the
  // focused session when its room fires a delta. Complements the existing
  // polls; when the watcher is off those continue to drive updates.
  const liveRooms = useMemo(() => {
    const rooms = ['sessions:active']
    if (focusedSessionId) rooms.push(`session:${focusedSessionId}`)
    return rooms
  }, [focusedSessionId])

  useLiveUpdates(
    liveRooms,
    useCallback(
      (room, delta) => {
        if (room === 'sessions:active') {
          if (delta.type === 'session.updated') {
            setMembers((prev) =>
              prev.map((m) =>
                m.session_id === delta.session_id
                  ? { ...m, message_count: delta.message_count, last_seen_at: delta.at }
                  : m
              )
            )
            return
          }
          if (delta.type === 'session.ended') {
            setMembers((prev) =>
              prev.map((m) =>
                m.session_id === delta.session_id
                  ? { ...m, status: 'ended', ended_at: delta.ended_at }
                  : m
              )
            )
            return
          }
          return
        }

        if (room.startsWith('session:') && delta.type !== 'session.created') {
          // Only refetch when the delta is for the currently focused session
          const id = room.slice('session:'.length)
          if (id !== focusedSessionId) return
          getSession(id)
            .then((response) => {
              setFocusedSession(response.session)
              setFocusedChunks(response.chunks || [])
            })
            .catch(() => {
              // Silent — next delta or poll will retry
            })
          if (viewMode === 'raw') {
            refreshRawTail()
          }
        }
      },
      [focusedSessionId, viewMode, refreshRawTail]
    )
  )

  // Reset raw state when switching sessions
  useEffect(() => {
    setRawEntries([])
    setRawSource(undefined)
    setRawFilePath(undefined)
    setRawTotalCount(0)
    setToggledBlocks(new Set())
    setAllExpanded(true)
  }, [focusedSessionId])

  const handleBroadcast = useCallback(async (content: string) => {
    if (!team || !content.trim()) return
    setIsBroadcasting(true)
    try {
      const result = await broadcastToTeam(team.id, content.trim())
      showToast(`Broadcast sent to ${result.recipients} session${result.recipients !== 1 ? 's' : ''}`)
    } catch (err: any) {
      showToast(err.message || 'Broadcast failed')
    } finally {
      setIsBroadcasting(false)
    }
  }, [team, showToast])

  const handleSendMessage = useCallback(async (content: string) => {
    if (broadcastMode) {
      await handleBroadcast(content)
      return
    }
    if (!focusedSessionId) return
    setIsSending(true)
    try {
      await sendLiveMessage(focusedSessionId, content)
      showToast('Message sent')
    } catch (err: any) {
      showToast(err.message || 'Failed to send message')
    } finally {
      setIsSending(false)
    }
  }, [focusedSessionId, broadcastMode, handleBroadcast, showToast])

  const handleRemoveMember = useCallback(async (sessionId: string) => {
    if (!team) return
    try {
      await removeTeamMember(team.id, sessionId)
      setMembers(prev => prev.filter(m => m.session_id !== sessionId))
      if (focusedSessionId === sessionId) setFocusedSessionId(null)
      showToast('Session removed from team')
    } catch {
      showToast('Failed to remove session')
    }
  }, [team, focusedSessionId, showToast])

  const handleDelete = useCallback(async () => {
    if (!team) return
    try {
      await deleteSessionTeam(team.id)
      setLocation('/teams')
    } catch {
      showToast('Failed to delete team')
    }
  }, [team, setLocation, showToast])

  const handleNameSave = useCallback(async () => {
    if (!team || !nameDraft.trim()) return
    try {
      const { team: updated } = await updateSessionTeam(team.id, { name: nameDraft.trim() })
      setTeam(prev => prev ? { ...prev, name: updated.name } : prev)
    } catch {}
    setEditingName(false)
  }, [team, nameDraft])

  // Add session search — show active sessions by default, search on input
  useEffect(() => {
    if (!showAddModal) {
      setAddResults([])
      return
    }
    let mounted = true
    setAddLoading(true)

    const load = async () => {
      try {
        if (addSearch.length >= 1) {
          // Fetch recent sessions and filter by nickname/session_id client-side
          const data = await getSessions({ limit: 100 })
          const q = addSearch.toLowerCase()
          const filtered = (data.sessions || []).filter(s =>
            (s.nickname && s.nickname.toLowerCase().includes(q)) ||
            s.session_id.toLowerCase().includes(q) ||
            (s.summary && s.summary.toLowerCase().includes(q))
          )
          if (mounted) setAddResults(filtered)
        } else {
          // Show active sessions by default
          const data = await getActiveSessions()
          if (mounted) {
            // Map active sessions to SessionDetail-like shape for display
            const sessions = (data.sessions || []).map((s: any) => ({
              id: s.transcript?.synced_session_id || s.session_id,
              session_id: s.session_id,
              nickname: s.nickname,
              summary: s.transcript?.summary || null,
              message_count: s.transcript?.message_count || null,
            })) as SessionDetail[]
            setAddResults(sessions)
          }
        }
      } catch {}
      if (mounted) setAddLoading(false)
    }

    const timer = setTimeout(load, addSearch.length >= 1 ? 200 : 0)
    return () => { mounted = false; clearTimeout(timer) }
  }, [showAddModal, addSearch])

  const handleAddSession = useCallback(async (sessionId: string) => {
    if (!team) return
    try {
      await addTeamMembers(team.id, [sessionId])
      await loadTeam()
      showToast('Session added to team')
    } catch {
      showToast('Failed to add session')
    }
  }, [team, loadTeam, showToast])

  const handleRefreshFocused = useCallback(async () => {
    if (!focusedSessionId) return
    try {
      await triggerSessionSync({ force: true })
      const response = await getSession(focusedSessionId)
      setFocusedSession(response.session)
      setFocusedChunks(response.chunks || [])
      showToast('Refreshed')
    } catch {}
  }, [focusedSessionId, showToast])

  const handleMemberDrop = useCallback(async (dropIdx: number) => {
    if (dragIdx === null || dragIdx === dropIdx || isReordering) {
      setDragIdx(null)
      setDragOverIdx(null)
      return
    }

    const previousMembers = members
    const reordered = [...members]
    const [moved] = reordered.splice(dragIdx, 1)
    reordered.splice(dropIdx, 0, moved)

    setMembers(reordered)
    setDragIdx(null)
    setDragOverIdx(null)
    setIsReordering(true)

    try {
      await reorderTeamMembers(id, reordered.map(m => m.session_id))
    } catch {
      setMembers(previousMembers)
      showToast('Failed to save session order')
    } finally {
      setIsReordering(false)
    }
  }, [dragIdx, id, isReordering, members, showToast])

  const handleSelectSession = useCallback((sessionId: string) => {
    setFocusedSessionId(sessionId)
  }, [])

  const handleOpenContextMenu = useCallback((member: SessionTeamMember, e: MouseEvent) => {
    setContextMenu({ member, position: { x: e.clientX, y: e.clientY } })
  }, [])

  const handleMemberDragStart = useCallback((idx: number) => {
    setDragIdx(idx)
  }, [])

  const handleMemberDragOver = useCallback((idx: number, e: DragEvent) => {
    e.preventDefault()
    setDragOverIdx(prev => (prev === idx ? prev : idx))
  }, [])

  const handleMemberDragLeave = useCallback((idx: number) => {
    setDragOverIdx(prev => (prev === idx ? null : prev))
  }, [])

  const handleMemberDragEnd = useCallback(() => {
    setDragIdx(null)
    setDragOverIdx(null)
  }, [])

  const handleDropAtIndex = useCallback((idx: number) => {
    void handleMemberDrop(idx)
  }, [handleMemberDrop])

  const lowerSearchQuery = searchQuery.toLowerCase()

  // Dragging a session should not re-parse the focused transcript on every hover update.
  const segments = useMemo(() => {
    return focusedChunks
      .flatMap(chunk => parseChunkContent(chunk.content))
      .filter(s => s.content.trim().length > 0)
      .filter(s => {
        if (s.role === 'tool_use') {
          if (!showTools) return false
          if (showBashOnly && s.toolName !== 'Bash') return false
          return true
        }
        if (s.role === 'user' && !showUser) return false
        if (s.role === 'assistant' && !showAssistant) return false
        if (s.role === 'thinking' && !showThinking) return false
        return true
      })
      .filter(s => {
        if (!lowerSearchQuery) return true
        return s.content.toLowerCase().includes(lowerSearchQuery)
          || (s.toolName?.toLowerCase().includes(lowerSearchQuery) ?? false)
      })
      .reverse()
  }, [focusedChunks, showUser, showAssistant, showThinking, showTools, showBashOnly, showCommandsOnly, lowerSearchQuery])

  const sortedSegments = useMemo(
    () => (sortOrder === 'asc' ? [...segments].reverse() : segments),
    [segments, sortOrder]
  )

  const filteredRawEntries = useMemo(() => {
    const orderedEntries = sortOrder === 'desc' ? [...rawEntries].reverse() : rawEntries

    return orderedEntries.filter(entry => {
      if (!entry.message) return false
      if (!showUser && entry.type === 'user') return false
      if (!showAssistant && entry.type === 'assistant') return false
      if (searchQuery) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : (entry.message.content || []).map((b: SessionContentBlock) =>
              b.text || b.thinking || b.name || ''
            ).join(' ')
        if (!text.toLowerCase().includes(lowerSearchQuery)) return false
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
  }, [
    lowerSearchQuery,
    rawEntries,
    searchQuery,
    showAssistant,
    showBashOnly,
    showCommandsOnly,
    showThinking,
    showTools,
    showUser,
    sortOrder,
  ])

  const focusedMember = useMemo(
    () => members.find(m => m.session_id === focusedSessionId),
    [members, focusedSessionId]
  )
  const activeMemberCount = useMemo(
    () => members.filter(m => m.status === 'active').length,
    [members]
  )
  const isActiveSession = focusedMember?.status === 'active'


  if (isLoading) return <div class={styles.page}><div class={styles.loading}>Loading team...</div></div>
  if (error || !team) return <div class={styles.page}><div class={styles.error}>{error || 'Team not found'}</div></div>

  return (
    <div class={styles.page}>
      {/* Top Bar */}
      <div class={styles.topbar}>
        <Link href="/teams" class={styles.backLink}><ArrowLeft size={14} /></Link>
        {editingName ? (
          <input
            class={styles.nameInput}
            value={nameDraft}
            onInput={(e) => setNameDraft((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleNameSave(); if (e.key === 'Escape') setEditingName(false) }}
            onBlur={handleNameSave}
            autoFocus
          />
        ) : (
          <h1 class={styles.teamTitle} onClick={() => { setNameDraft(team.name); setEditingName(true) }}>
            {team.name}
          </h1>
        )}
        {team.project_handle && <span class={styles.projectBadge}>{team.project_name || team.project_handle}</span>}
        <span class={styles.teamMeta}>
          <Radio size={12} class={styles.activeIcon} />
          {activeMemberCount} active / {members.length} sessions
        </span>
        <div style={{ marginLeft: 'auto' }} />
        <button class={styles.deleteTeamBtn} onClick={() => setShowDeleteConfirm(true)} title="Delete team">
          <Trash2 size={14} />
        </button>
      </div>

      <div class={styles.main}>
        {/* Left Panel - Session Cards */}
        <div class={styles.sessionsPanel}>
          <div class={styles.sessionsPanelHeader}>
            <h2>Sessions</h2>
            <button class={styles.addBtn} onClick={() => { setShowAddModal(true); setAddSearch('') }}>
              <Plus size={12} /> Add
            </button>
          </div>
          <div class={styles.sessionsList}>
            {members.map((member, idx) => (
              <SessionCard
                key={member.session_id}
                member={member}
                idx={idx}
                isSelected={focusedSessionId === member.session_id}
                isDragging={dragIdx === idx}
                isDropTarget={dragOverIdx === idx && dragIdx !== idx}
                isReordering={isReordering}
                onSelect={handleSelectSession}
                onOpenContextMenu={handleOpenContextMenu}
                onDragStart={handleMemberDragStart}
                onDragOver={handleMemberDragOver}
                onDragLeave={handleMemberDragLeave}
                onDrop={handleDropAtIndex}
                onDragEnd={handleMemberDragEnd}
              />
            ))}
            {members.length === 0 && (
              <div class={styles.emptyMembers}>
                No sessions yet. Click "Add" to add sessions.
              </div>
            )}
          </div>
        </div>

        {/* Right Panel - Focused Session */}
        <div class={styles.focusPanel}>
          {!focusedSessionId ? (
            <div class={styles.focusEmpty}>
              <Users size={48} class={styles.focusEmptyIcon} />
              <p>Select a session to view its conversation</p>
            </div>
          ) : focusLoading ? (
            <div class={styles.focusEmpty}><p>Loading session...</p></div>
          ) : !focusedSession ? (
            <div class={styles.focusEmpty}><p>Session not synced yet</p></div>
          ) : (
            <div class={styles.focusContent}>
              <div class={styles.focusHeader}>
                <span class={`${styles.statusDot} ${styles[focusedMember?.status || 'inactive']}`} />
                <span class={styles.focusTitle}>
                  {focusedSession.nickname || focusedSession.id.slice(0, 8)}
                </span>
                {isActiveSession && (
                  <span class={styles.liveIndicator}><span class={styles.liveDot} /> Live</span>
                )}
                {focusedMember?.resumable && !isActiveSession && (
                  <button class={styles.resumeBtn} onClick={() => {
                    navigator.clipboard.writeText(`claude --resume ${focusedSessionId}`)
                    showToast('Resume command copied')
                  }}>
                    <Play size={10} /> Resume
                  </button>
                )}
              </div>
              <SessionToolbar
                class={styles.focusToolbar}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
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
                onRefresh={handleRefreshFocused}
                sessionId={focusedSession?.session_id}
                filePath={rawFilePath || focusedSession?.file_path || undefined}
                statsSlot={focusedSession && (
                  <>
                    {focusedSession.message_count && (
                      <span><FileText size={12} /> {focusedSession.message_count} msgs</span>
                    )}
                    {focusedSession.context_window_tokens != null && focusedSession.context_window_tokens > 0 && (
                      <span>{Math.round(focusedSession.context_window_tokens / 1000)}k ctx</span>
                    )}
                  </>
                )}
              />

              <div class={styles.conversation} ref={conversationRef}>
                {viewMode === 'parsed' ? (
                  <VirtualList
                    items={sortedSegments}
                    containerRef={conversationRef}
                    estimateHeight={96}
                    identity={sortedSegments}
                    renderItem={(segment) => {
                      if (segment.role === 'tool_use') {
                        const isCommand = segment.toolName === 'Bash'
                        return (
                          <div class={styles.toolBlock}>
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
                      return (
                        <div class={`${styles.segment} ${styles[segment.role]}`}>
                          <div class={styles.segmentHeader}>
                            {segment.role === 'user' ? <><User size={12} /> User</> :
                             segment.role === 'thinking' ? <><Bot size={12} /> Thinking</> :
                             <><Bot size={12} /> Assistant</>}
                          </div>
                          <div class={styles.segmentContent}>{segment.content}</div>
                        </div>
                      )
                    }}
                  />
                ) : rawLoading ? (
                  <LoadingMessage stableKey={focusedSessionId || 'raw'} />
                ) : (
                  <>
                  {rawSource === 'backup' && (
                    <ArchiveBadge class={styles.archiveBadge} />
                  )}
                  <VirtualList
                    items={filteredRawEntries}
                    containerRef={conversationRef}
                    estimateHeight={140}
                    identity={`${focusedSessionId}-${viewMode}-${filteredRawEntries.length}-${allExpanded ?? 'mixed'}-${toggledBlocks.size}`}
                    renderItem={(entry, i) => {
                      const blocks: SessionContentBlock[] = typeof entry.message?.content === 'string'
                        ? [{ type: 'text', text: entry.message.content }]
                        : (entry.message?.content || [])
                      const entryKey = getRawEntryKey(entry, i)

                      return (
                        <div key={entryKey} class={`${styles.segment} ${styles[entry.type] || ''}`}>
                          <div class={styles.segmentHeader}>
                            {entry.type === 'user' ? <><User size={12} /> <span>User</span></> : <><Bot size={12} /> <span>Assistant</span></>}
                            {entry.message?.model && <span class={styles.modelBadge}>{entry.message.model}</span>}
                          </div>
                          {blocks.map((block, bi) => {
                            const blockKey = getRawBlockKey(entry, i, block, bi)

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
                  </>
                )}
              </div>

              {isActiveSession && (
                <ChatInput
                  onSend={handleSendMessage}
                  sending={isSending || isBroadcasting}
                  placeholder={broadcastMode
                    ? `Broadcast to all active sessions... (Cmd+Enter)`
                    : `Send to ${focusedSession.nickname || 'session'}... (Cmd+Enter)`}
                  broadcastMode={broadcastMode}
                  onBroadcastToggle={setBroadcastMode}
                />
              )}

              {!isActiveSession && focusedMember?.resumable && (
                <div class={styles.inactiveBanner}>
                  Session is inactive but resumable.
                  <button class={styles.resumeLink} onClick={() => {
                    navigator.clipboard.writeText(`claude --resume ${focusedSessionId}`)
                    showToast('Resume command copied')
                  }}>
                    Copy resume command
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Add Session Modal */}
      {showAddModal && (
        <div class={styles.modalOverlay} onClick={(e) => { if (e.target === e.currentTarget) setShowAddModal(false) }}>
          <div class={styles.modal}>
            <h2 class={styles.modalTitle}>Add Session to Team</h2>
            <input
              class={styles.modalSearch}
              placeholder="Search sessions..."
              value={addSearch}
              onInput={(e) => setAddSearch((e.target as HTMLInputElement).value)}
              autoFocus
            />
            <div class={styles.modalResults}>
              {addLoading && addResults.length === 0 && <p class={styles.modalLoading}>Searching...</p>}
              {addResults.filter(session => !members.some(m => m.session_id === session.session_id)).map(session => {
                return (
                  <div key={session.id} class={styles.modalResult}>
                    <div class={styles.modalResultInfo}>
                      <span class={styles.modalResultName}>{session.nickname || session.session_id.slice(0, 8)}</span>
                      {session.summary && <span class={styles.modalResultSummary}>{session.summary}</span>}
                    </div>
                    <button
                      class={styles.modalAddBtn}
                      onClick={() => handleAddSession(session.session_id)}
                    >
                      Add
                    </button>
                  </div>
                )
              })}
              {!addLoading && addSearch.length >= 2 && addResults.length === 0 && (
                <p class={styles.modalLoading}>No sessions found</p>
              )}
            </div>
            <button class={styles.modalClose} onClick={() => setShowAddModal(false)}>Close</button>
          </div>
        </div>
      )}

      {showDeleteConfirm && (
        <ConfirmModal
          title="Delete Team"
          message="Delete this team? Sessions will not be affected."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {contextMenu && (
        <TeamCardContextMenu
          member={contextMenu.member}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
          onViewSession={(sessionId) => {
            window.open(`/sessions/${sessionId}`, '_blank')
          }}
          onCopyId={(text) => {
            navigator.clipboard.writeText(text)
            showToast('UUID copied')
          }}
          onCopyResume={(sessionId) => {
            navigator.clipboard.writeText(`claude --resume ${sessionId}`)
            showToast('Resume command copied')
          }}
          onRemove={(sessionId) => handleRemoveMember(sessionId)}
        />
      )}
    </div>
  )
}

/* ─── Context Menu ─── */

interface TeamCardContextMenuProps {
  member: SessionTeamMember
  position: { x: number; y: number }
  onClose: () => void
  onViewSession: (sessionId: string) => void
  onCopyId: (text: string) => void
  onCopyResume: (sessionId: string) => void
  onRemove: (sessionId: string) => void
}

function TeamCardContextMenu({ member, position, onClose, onViewSession, onCopyId, onCopyResume, onRemove }: TeamCardContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const timer = setTimeout(() => document.addEventListener('click', handleClick), 0)
    return () => { clearTimeout(timer); document.removeEventListener('click', handleClick) }
  }, [onClose])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  // Clamp to viewport
  const menuWidth = 200, menuHeight = 140, pad = 8
  let x = position.x, y = position.y
  if (typeof window !== 'undefined') {
    if (x > window.innerWidth - menuWidth - pad) x = window.innerWidth - menuWidth - pad
    if (y > window.innerHeight - menuHeight - pad) y = window.innerHeight - menuHeight - pad
  }

  return (
    <div
      ref={menuRef}
      class={styles.ctxMenu}
      style={{ left: `${x}px`, top: `${y}px` }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button class={styles.ctxItem} onClick={() => { onViewSession(member.db_id || member.session_id); onClose() }}>
        <ExternalLink size={13} /> View Session
      </button>
      <button class={styles.ctxItem} onClick={() => { onCopyId(member.session_id); onClose() }}>
        <Copy size={13} /> Copy UUID
      </button>
      {member.resumable && (
        <button class={styles.ctxItem} onClick={() => { onCopyResume(member.session_id); onClose() }}>
          <Play size={13} /> Copy Resume Command
        </button>
      )}
      <div class={styles.ctxDivider} />
      <button class={clsx(styles.ctxItem, styles.ctxItemDanger)} onClick={() => { onRemove(member.session_id); onClose() }}>
        <Trash2 size={13} /> Remove from Team
      </button>
    </div>
  )
}
