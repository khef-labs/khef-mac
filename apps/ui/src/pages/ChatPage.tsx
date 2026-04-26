import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import { useLocation, Link } from 'wouter-preact'
import {
  MessageSquare, Send, Loader2, Square,
  Pencil, Trash2, Copy, Check,
  PanelLeftClose, PanelLeft,
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
} from '../lib/api'
import type {
  AssistantChat, AssistantChatMessage, ChatDelegation, SendChatResponse,
} from '../types'
import { useToast, ConfirmModal } from '../components/ui'
import { ConversationContextMenu } from '../components/shared/ConversationContextMenu'
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

const FILTER_BACKENDS: Backend[] = ['claude-code', 'gemini', 'codex-cli']

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
                if (backendFilter === backend) {
                  setBackendFilter('all')
                } else {
                  autoSelectRef.current = true
                  setBackendFilter(backend)
                  setNewChatBackend(backend)
                }
              }}
            >
              {BACKEND_LABELS[backend]}
            </button>
          ))}
          <span class={styles.filterSpacer} />
          <button
            class={styles.newChatBtn}
            onClick={() => startNewChat(newChatBackend)}
            title="New chat"
          >
            <Pencil size={14} />
          </button>
        </div>

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
