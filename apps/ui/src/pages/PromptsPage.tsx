import { useState, useEffect, useMemo, useRef } from 'preact/hooks'
import { Link, useLocation, useSearch } from 'wouter-preact'
import { FileText, Trash2, RefreshCw, Plus, Search, Bot, Terminal, ScrollText, Copy, FolderOpen } from 'lucide-preact'
import clsx from 'clsx'
import { getPrompts, deletePrompt, discoverPrompts } from '../lib/api'
import type { Prompt, PromptType } from '../types'
import { cardStyles, ConfirmModal, useToast, SortBar } from '../components/ui'
import type { SortField as SortFieldDef, SortState } from '../components/ui'
import { useDocumentTitle } from '../hooks'
import { useKdagBackends } from '../hooks/useKdagBackends'
import styles from './PromptsPage.module.css'

const PROMPT_SORT_FIELDS: SortFieldDef[] = [
  { key: 'created_at', label: 'Created' },
  { key: 'updated_at', label: 'Updated' },
  { key: 'title', label: 'Title' },
]

interface ContextMenuState {
  prompt: Prompt
  position: { x: number; y: number }
}

interface Props {
  handle?: string
  embedded?: boolean
}

function formatDate(dateString: string | undefined): string {
  if (!dateString) return ''
  const date = new Date(dateString)
  if (isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function getPromptTypeIcon(type: PromptType) {
  switch (type) {
    case 'agent':
      return <Bot size={12} />
    case 'command':
      return <Terminal size={12} />
    case 'prompt':
      return <ScrollText size={12} />
    default:
      return <FileText size={12} />
  }
}

export function PromptsPage({ handle, embedded }: Props) {
  const { showToast } = useToast()
  useDocumentTitle('Prompts')
  const [, setLocation] = useLocation()
  const searchString = useSearch()
  const searchParams = new URLSearchParams(searchString)
  const assistantFilter = handle || searchParams.get('assistant') || ''

  const { backends } = useKdagBackends()

  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterAssistant, setFilterAssistant] = useState(assistantFilter)
  const [deleteTarget, setDeleteTarget] = useState<Prompt | null>(null)
  const [isDiscovering, setIsDiscovering] = useState(false)
  const [sort, setSort] = useState<SortState>({ field: 'created_at', direction: 'desc' })
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    async function load() {
      setIsLoading(true)
      setError(null)
      try {
        const params: { assistant?: string } = {}
        if (filterAssistant) params.assistant = filterAssistant
        const res = await getPrompts(params)
        setPrompts(res.prompts)
      } catch (err) {
        console.warn('Failed to load prompts:', err)
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [filterAssistant])

  const filteredPrompts = useMemo(() => {
    let list = prompts
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      list = list.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.handle.toLowerCase().includes(q) ||
          (p.description && p.description.toLowerCase().includes(q))
      )
    }
    const dir = sort.direction === 'asc' ? 1 : -1
    const sorted = [...list].sort((a, b) => {
      if (sort.field === 'title') {
        return dir * a.title.localeCompare(b.title)
      }
      const key = sort.field as 'updated_at' | 'created_at'
      return dir * (new Date(a[key] || 0).getTime() - new Date(b[key] || 0).getTime())
    })
    return sorted
  }, [prompts, searchQuery, sort])

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await deletePrompt(deleteTarget.id)
      setPrompts((prev) => prev.filter((p) => p.id !== deleteTarget.id))
      showToast('Prompt deleted')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete prompt')
    } finally {
      setDeleteTarget(null)
    }
  }

  const handleDiscover = async () => {
    setIsDiscovering(true)
    setError(null)
    try {
      const result = await discoverPrompts(filterAssistant || undefined)
      const created = result.results.filter((r) => r.action === 'created').length
      const updated = result.results.filter((r) => r.action === 'updated').length

      if (created || updated) {
        const parts = []
        if (created) parts.push(`${created} created`)
        if (updated) parts.push(`${updated} updated`)
        showToast(`Discovered: ${parts.join(', ')}`)
      } else {
        showToast('All prompts up to date')
      }

      // Reload prompts
      const params: { assistant?: string } = {}
      if (filterAssistant) params.assistant = filterAssistant
      const res = await getPrompts(params)
      setPrompts(res.prompts)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Discovery failed')
    } finally {
      setIsDiscovering(false)
    }
  }

  const handleFilterChange = (value: string) => {
    setFilterAssistant(value)
    // Update URL without navigation
    if (value) {
      setLocation(`/prompts?assistant=${value}`, { replace: true })
    } else {
      setLocation('/prompts', { replace: true })
    }
  }

  const handleContextMenu = (e: MouseEvent, prompt: Prompt) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ prompt, position: { x: e.clientX, y: e.clientY } })
  }

  const copyHandle = async () => {
    if (!contextMenu) return
    try {
      await navigator.clipboard.writeText(contextMenu.prompt.handle)
      showToast('Handle copied')
    } catch (err) {
      console.error('Failed to copy:', err)
    }
    setContextMenu(null)
  }

  const copyPath = async () => {
    if (!contextMenu) return
    const sourcePath = contextMenu.prompt.assistants.find((a) => a.source_path)?.source_path
    if (!sourcePath) {
      showToast('No file path available')
      setContextMenu(null)
      return
    }
    try {
      await navigator.clipboard.writeText(sourcePath)
      showToast('Path copied')
    } catch (err) {
      console.error('Failed to copy:', err)
    }
    setContextMenu(null)
  }

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClick)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', handleClick)
    }
  }, [contextMenu])

  // Close context menu on Escape
  useEffect(() => {
    if (!contextMenu) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setContextMenu(null)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [contextMenu])

  // Close context menu on scroll
  useEffect(() => {
    if (!contextMenu) return
    const handleScroll = (event: Event) => {
      if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) {
        return
      }
      setContextMenu(null)
    }
    window.addEventListener('scroll', handleScroll, true)
    return () => window.removeEventListener('scroll', handleScroll, true)
  }, [contextMenu])

  // Clamp context menu position to viewport
  const getClampedMenuPosition = () => {
    if (!contextMenu) return { x: 0, y: 0 }
    const menuWidth = 180
    const menuHeight = 120
    const padding = 8
    let x = contextMenu.position.x
    let y = contextMenu.position.y
    if (typeof window !== 'undefined') {
      if (x > window.innerWidth - menuWidth - padding) x = window.innerWidth - menuWidth - padding
      if (y > window.innerHeight - menuHeight - padding) y = window.innerHeight - menuHeight - padding
      if (x < padding) x = padding
      if (y < padding) y = padding
    }
    return { x, y }
  }

  return (
    <div class={embedded ? undefined : styles.page}>
      {!embedded && (
        <header class={styles.header}>
          <h1>Prompts</h1>
          <p class={styles.subtitle}>Reusable prompt templates for coding assistants</p>
        </header>
      )}

      <div class={styles.toolbar}>
        <div class={styles.toolbarLeft}>
          <div class={styles.searchWrapper}>
            <Search size={16} class={styles.searchIcon} />
            <input
              type="text"
              class={styles.searchInput}
              placeholder="Search prompts..."
              value={searchQuery}
              onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
            />
          </div>
          <select
            class={styles.filterSelect}
            value={filterAssistant}
            onChange={(e) => handleFilterChange((e.target as HTMLSelectElement).value)}
          >
            <option value="">All Assistants</option>
            {backends.map(b => (
              <option key={b.key} value={b.key}>{b.name}</option>
            ))}
          </select>
          <SortBar fields={PROMPT_SORT_FIELDS} value={sort} onChange={setSort} />
        </div>
        <div class={styles.toolbarRight}>
          <button
            class={styles.iconButton}
            onClick={handleDiscover}
            disabled={isDiscovering}
            title="Discover prompts from disk"
          >
            <RefreshCw size={16} class={clsx(isDiscovering && styles.spinning)} />
          </button>
          <Link href="/prompts/new" class={styles.addButton}>
            <Plus size={16} />
            New Prompt
          </Link>
        </div>
      </div>

      {error && <div class={styles.error}>{error}</div>}

      {isLoading ? (
        <div class={styles.loading}>Loading prompts...</div>
      ) : filteredPrompts.length === 0 ? (
        <div class={styles.empty}>
          <FileText size={48} />
          <p>{searchQuery ? 'No prompts match your search' : 'No prompts found'}</p>
          <p class={styles.hint}>
            {searchQuery
              ? 'Try a different search term'
              : 'Click "Discover" to import prompts from disk, or create a new one'}
          </p>
        </div>
      ) : (
        <div class={styles.promptsList}>
          {filteredPrompts.map((prompt) => (
            <Link
              key={prompt.id}
              href={`/prompts/${prompt.id}`}
              class={clsx(cardStyles.card, styles.promptCard)}
              onContextMenu={(e: MouseEvent) => handleContextMenu(e, prompt)}
            >
              <h3 class={styles.promptTitle}>{prompt.title}</h3>
              <span class={styles.promptHandle}>{prompt.handle}</span>
              {prompt.description && (
                <p class={styles.promptDescription}>{prompt.description}</p>
              )}
              <div class={styles.promptMeta}>
                {prompt.assistants.length === 0 ? (
                  <span class={styles.universalBadge}>Universal</span>
                ) : (
                  prompt.assistants.map((a) => (
                    <span
                      key={`${a.assistant_handle}-${a.prompt_type}`}
                      class={styles.assistantBadge}
                    >
                      {getPromptTypeIcon(a.prompt_type)}
                      {a.assistant_handle}
                    </span>
                  ))
                )}
                {formatDate(prompt.updated_at) && (
                  <span class={styles.metaItem}>{formatDate(prompt.updated_at)}</span>
                )}
              </div>
              <button
                class={styles.deleteButton}
                title="Delete prompt"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setDeleteTarget(prompt)
                }}
              >
                <Trash2 size={14} />
              </button>
            </Link>
          ))}
        </div>
      )}

      {contextMenu && (() => {
        const pos = getClampedMenuPosition()
        return (
          <div
            ref={menuRef}
            class={styles.contextMenu}
            style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
            onClick={(e: Event) => e.stopPropagation()}
            onMouseDown={(e: Event) => e.stopPropagation()}
          >
            <button type="button" class={styles.menuItem} onClick={copyPath}>
              <span>Copy Path</span>
              <FolderOpen size={14} />
            </button>
            <button type="button" class={styles.menuItem} onClick={copyHandle}>
              <span>Copy Handle</span>
              <Copy size={14} />
            </button>
            <div class={styles.menuDivider} />
            <button
              type="button"
              class={clsx(styles.menuItem, styles.menuItemDanger)}
              onClick={() => {
                const prompt = contextMenu.prompt
                setContextMenu(null)
                setDeleteTarget(prompt)
              }}
            >
              <span>Delete</span>
              <Trash2 size={14} />
            </button>
          </div>
        )
      })()}

      {deleteTarget && (
        <ConfirmModal
          title="Delete Prompt"
          message={`Delete "${deleteTarget.title}"? This cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
