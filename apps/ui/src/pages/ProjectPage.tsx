import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import { useLocation, Link } from 'wouter-preact'
import { FolderOpen, Plus, Pencil, X, Repeat, Bot, Network, FileText, ScrollText, ClipboardList, Copy, Check, GitBranch, ChevronLeft, ChevronRight, FileUp, FileSpreadsheet, Brain, Layers, Paperclip } from 'lucide-preact'
import clsx from 'clsx'
import { SearchBar } from '../components/search'
import { ProjectFiltersPanel, type ProjectFilterValues } from '../components/project'
import { MemoryCard, MemoryContextMenu, AddToCollectionModal } from '../components/shared'
import { TagInput, ConfirmModal, useToast } from '../components/ui'
import { useDocumentTitle } from '../hooks'
import {
  getSessionContext,
  searchMemories,
  vectorSearch,
  getProjectMemoryTypes,
  createMemory,
  updateProject,
  deleteProject,
  getMemory,
  syncProjectRules,
  syncProjectKnowledge,
  updateMemory,
  deleteMemory,
  importGoogleDoc,
  setMemoryMetadataField,
  deleteMemoryMetadataField,
} from '../lib/api'
import { MEMORY_TYPES, getTypeLabel, buildTypeHierarchy, uniqueTypeList } from '../lib/memoryTypes'
import { setNavContext } from '../lib/navContext'
import {
  getProjectNavContext,
  updateProjectNavIndex,
  getPrevProjectId,
  getNextProjectId,
  getProjectPositionInfo,
} from '../lib/projectNavContext'
import type { Memory, Pagination, SessionContext, MemoryType } from '../types'
import styles from './ProjectPage.module.css'

interface Props {
  projectId: string
}

const PAGE_SIZE_OPTIONS = [20, 50, 100]

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const STATUS_FALLBACK: Record<string, string[]> = {
  'user-todo': ['open', 'in_progress', 'done', 'blocked', 'canceled'],
  'assistant-todo': ['open', 'in_progress', 'done', 'blocked', 'canceled'],
  decision: ['proposed', 'accepted', 'rejected', 'superseded'],
  pattern: ['proposed', 'active', 'deprecated'],
  context: ['current', 'updated', 'outdated'],
  commands: ['unverified', 'verified', 'deprecated'],
  knowledge: ['current', 'deprecated'],
}

function parseMemoryIdQuery(value: string): string[] | null {
  if (!value) return null
  const tokens = value
    .trim()
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)

  if (tokens.length === 0) return null
  if (!tokens.every((token) => UUID_PATTERN.test(token))) return null

  return tokens
}

export function ProjectPage({ projectId }: Props) {
  const [, setLocation] = useLocation()
  const { showToast } = useToast()

  // Session context data
  const [sessionContext, setSessionContext] = useState<SessionContext | null>(null)
  const [isLoadingContext, setIsLoadingContext] = useState(true)
  const [contextError, setContextError] = useState<string | null>(null)
  const loadedProjectName = sessionContext?.project?.display_name || sessionContext?.project?.name
  const projectTitle = loadedProjectName || projectId

  useDocumentTitle(loadedProjectName ? `Project - ${loadedProjectName}` : 'Project - Loading')

  // Navigation state
  const [navPosition, setNavPosition] = useState<{ current: number; total: number } | null>(null)

  // Search and filter state
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<ProjectFilterValues>({
    type: '',
    subtype: '',
    tag: '',
    handle: '',
    status: '',
    sort_field: 'created_at',
    sort_dir: 'desc',
    date: '',
    date_from: '',
    date_to: '',
    date_range_mode: false,
    pinned: '',
    search_mode: '',
  })
  const [typeOptions, setTypeOptions] = useState<string[] | null>(null)
  const [allTypeOptions, setAllTypeOptions] = useState<string[] | null>(null)
  const [topLevelTypeOptions, setTopLevelTypeOptions] = useState<string[] | null>(null)
  const [allTypesData, setAllTypesData] = useState<Array<{ type: string; parent_type?: string }>>([])
  const [rulesCount, setRulesCount] = useState(0)
  const [typeHierarchy, setTypeHierarchy] = useState<Record<string, string[]>>({})
  const googleDocSubtypes = allTypesData.filter((t) => t.parent_type === 'google-doc').map((t) => t.type)

  // Memory list state
  const [memories, setMemories] = useState<Memory[]>([])
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [isLoadingMemories, setIsLoadingMemories] = useState(true)
  const [memoriesError, setMemoriesError] = useState<string | null>(null)
  const [pageSize, setPageSize] = useState(20)
  const [currentPage, setCurrentPage] = useState(1)
  const [refreshKey, setRefreshKey] = useState(0)
  const [memoryIdFilter, setMemoryIdFilter] = useState<string[]>([])
  const [missingMemoryCount, setMissingMemoryCount] = useState(0)
  const [activeSummary, setActiveSummary] = useState<{ title: string; memories: Memory[] } | null>(
    null
  )

  // Create memory state
  const [showCreate, setShowCreate] = useState(false)
  const [createTitle, setCreateTitle] = useState('')
  const [createHandle, setCreateHandle] = useState('')
  const [createContent, setCreateContent] = useState('')
  const [createType, setCreateType] = useState<MemoryType>('user-note')
  const [createSubtype, setCreateSubtype] = useState('')
  const [createTags, setCreateTags] = useState<string[]>([])
  const [createExternalUrl, setCreateExternalUrl] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  // Edit project state
  const [isEditingProject, setIsEditingProject] = useState(false)
  const [editName, setEditName] = useState('')
  const [editHandle, setEditHandle] = useState('')
  const [editDisplayName, setEditDisplayName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editPath, setEditPath] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [isSavingProject, setIsSavingProject] = useState(false)
  const [isDeletingProject, setIsDeletingProject] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Sync rules state
  const [isSyncingRules, setIsSyncingRules] = useState(false)
  const [syncRulesFlash, setSyncRulesFlash] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  // Copy ID state
  const [copiedId, setCopiedId] = useState(false)

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ memory: Memory; x: number; y: number } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Memory | null>(null)
  const [isDeletingMemory, setIsDeletingMemory] = useState(false)
  const [addToCollectionTarget, setAddToCollectionTarget] = useState<Memory | null>(null)

  // Import file ref
  const importInputRef = useRef<HTMLInputElement>(null)

  // Google Doc import modal state
  const [showGoogleDocImport, setShowGoogleDocImport] = useState(false)
  const [googleDocUrl, setGoogleDocUrl] = useState('')
  const [googleDocHandle, setGoogleDocHandle] = useState('')
  const [googleDocType, setGoogleDocType] = useState<MemoryType>('user-note')
  const [isImportingGoogleDoc, setIsImportingGoogleDoc] = useState(false)
  const [googleDocError, setGoogleDocError] = useState<string | null>(null)

  const resolveStatusForType = useCallback(
    async (projectIdForStatus: string, type: MemoryType, currentStatus: string) => {
      try {
        const data = await getProjectMemoryTypes(projectIdForStatus)
        const info = data?.memory_types?.find((t) => t.type === type)
        const statusValues = info?.statuses?.map((s) => s.value).filter(Boolean) || []
        const fallback = STATUS_FALLBACK[type] || []
        const options = statusValues.length > 0 ? statusValues : fallback
        if (options.length === 0) return currentStatus
        return options.includes(currentStatus) ? currentStatus : options[0]
      } catch {
        const fallback = STATUS_FALLBACK[type] || []
        if (fallback.length === 0) return currentStatus
        return fallback.includes(currentStatus) ? currentStatus : fallback[0]
      }
    },
    []
  )

  // Load project context and memory types in parallel on mount
  useEffect(() => {
    let mounted = true
    setIsLoadingContext(true)
    setContextError(null)

    Promise.all([
      getSessionContext(projectId),
      getProjectMemoryTypes(projectId),
    ])
      .then(([contextData, typesData]) => {
        if (!mounted) return
        setSessionContext(contextData)

        // Process memory types
        if (typesData) {
          const memoryTypes = typesData.memory_types || []
          const allTypes = uniqueTypeList(memoryTypes.map((entry) => entry.type))
          setAllTypeOptions(allTypes.length ? allTypes : null)
          setAllTypesData(memoryTypes.map((entry) => ({ type: entry.type, parent_type: entry.parent_type })))
          setRulesCount(memoryTypes.find((t) => t.type === 'assistant-rule')?.usage_count ?? 0)
          const { hierarchy } = buildTypeHierarchy(memoryTypes)
          setTypeHierarchy(hierarchy)
          const topLevelTypes = uniqueTypeList(
            memoryTypes
              .filter((entry) => !entry.parent_type)
              .map((entry) => entry.type)
          )
          setTopLevelTypeOptions(topLevelTypes.length ? topLevelTypes : null)
          const available = uniqueTypeList(memoryTypes
            .filter((entry) => {
              const count =
                typeof entry.usage_count === 'number'
                  ? entry.usage_count
                : Number(entry.usage_count)
              return Number.isFinite(count) ? count > 0 : false
            })
            .map((entry) => entry.type))
          setTypeOptions(available.length ? available : null)
        } else {
          setTypeOptions(null)
          setAllTypeOptions(null)
          setTopLevelTypeOptions(null)
          setAllTypesData([])
          setTypeHierarchy({})
        }
      })
      .catch((err) => {
        if (!mounted) return
        setContextError(err.message || 'Failed to load project context')
      })
      .finally(() => {
        if (mounted) setIsLoadingContext(false)
      })

    return () => {
      mounted = false
    }
  }, [projectId])

  useEffect(() => {
    if (!sessionContext?.project) return
    const project = sessionContext.project
    setEditName(project.name || '')
    setEditDisplayName(project.display_name || '')
    setEditDescription(project.description || '')
  }, [sessionContext])

  useEffect(() => {
    const children = typeHierarchy[createType]
    if (!children || children.length === 0) {
      if (createSubtype) setCreateSubtype('')
      return
    }
    if (!createSubtype || !children.includes(createSubtype)) {
      setCreateSubtype(children[0])
    }
  }, [createType, createSubtype, typeHierarchy])

  // Set up navigation position from context
  useEffect(() => {
    const context = getProjectNavContext()
    if (!context) {
      setNavPosition(null)
      return
    }

    // Verify current project is in the list and update index
    const idx = context.ids.indexOf(projectId)
    if (idx === -1) {
      setNavPosition(null)
      return
    }

    if (idx !== context.currentIndex) {
      updateProjectNavIndex(idx)
    }

    setNavPosition(getProjectPositionInfo())
  }, [projectId])

  // Navigate to previous project
  const navigatePrev = useCallback(() => {
    const prevId = getPrevProjectId()
    if (prevId) {
      setLocation(`/projects/${prevId}`)
    }
  }, [setLocation])

  // Navigate to next project
  const navigateNext = useCallback(() => {
    const nextId = getNextProjectId()
    if (nextId) {
      setLocation(`/projects/${nextId}`)
    }
  }, [setLocation])

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't navigate if editing or in input
      const target = event.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        navigatePrev()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        navigateNext()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigatePrev, navigateNext])

  // Restore filters only when returning from a memory detail page
  const FILTER_KEY = `khefProjectFilters:${projectId}`
  const RETURN_KEY = `khefProjectReturn:${projectId}`

  useEffect(() => {
    if (typeof window === 'undefined') return
    const returning = window.sessionStorage.getItem(RETURN_KEY)
    window.sessionStorage.removeItem(RETURN_KEY)

    if (!returning) {
      // Fresh visit — clear any stale stored filters
      window.sessionStorage.removeItem(FILTER_KEY)
      return
    }

    try {
      const stored = window.sessionStorage.getItem(FILTER_KEY)
      if (!stored) return
      const parsed = JSON.parse(stored) as {
        query?: string
        filters?: ProjectFilterValues
      }
      if (parsed?.filters) {
        setFilters((prev) => ({ ...prev, ...parsed.filters }))
      }
      if (typeof parsed?.query === 'string') {
        setQuery(parsed.query)
      }
    } catch {
      // Ignore malformed storage
    }
  }, [projectId])


  // Fetch memories when filters, query, page, or page size change
  useEffect(() => {
    let cancelled = false

    const loadByIds = async () => {
      const ids = Array.from(new Set(memoryIdFilter))
      try {
        const responses = await Promise.all(
          ids.map(async (id) => {
            try {
              return await getMemory(id, projectId)
            } catch (error) {
              console.warn('Failed to fetch memory by id', id, error)
              return null
            }
          })
        )

        if (cancelled) return

        const loaded = responses.filter((memory): memory is Memory => Boolean(memory))
        setMemories(loaded)
        setPagination({
          total_count: loaded.length,
          limit: loaded.length || pageSize,
          offset: 0,
          has_more: false,
        })
        const missing = ids.length - loaded.length
        setMissingMemoryCount(missing > 0 ? missing : 0)
        if (loaded.length === 0) {
          setMemoriesError('No memories found for provided IDs.')
        }
      } catch (err: any) {
        if (cancelled) return
        setMemoriesError(err?.message || 'Failed to load memories')
        setMemories([])
        setPagination(null)
      }
    }

    const loadBySearch = async () => {
      const offset = (currentPage - 1) * pageSize
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      const dateFilters = filters.date_range_mode
        ? {
            created_after: filters.date_from || undefined,
            created_before: filters.date_to || undefined,
          }
        : filters.date
          ? { created_after: filters.date, created_before: filters.date }
          : { created_after: undefined, created_before: undefined }

      try {
        // Use vector search endpoint for semantic mode (faster than search_mode param)
        const response = filters.search_mode === 'semantic' && query
          ? await vectorSearch({
              q: query,
              project_id: projectId,
              type: ((filters.subtype || filters.type) as MemoryType) || undefined,
              limit: pageSize,
              compact: true,
            })
          : await searchMemories({
              q: query || undefined,
              project_id: projectId,
              type: ((filters.subtype || filters.type) as MemoryType) || undefined,
              tag: filters.tag || undefined,
              handle: filters.handle || undefined,
              status: (filters.type || filters.subtype) ? filters.status || undefined : undefined,
              sort: (filters.sort_field === 'slide_order' ? 'created_at' : filters.sort_field) as 'relevance' | 'updated_at' | 'created_at' | 'title',
              order: filters.sort_dir,
              compact: filters.sort_field === 'slide_order' ? false : true,
              limit: pageSize,
              offset,
              created_after: dateFilters.created_after,
              created_before: dateFilters.created_before,
              tz: timeZone,
              pinned: filters.pinned === 'true' ? true : undefined,
            })

        if (cancelled) return

        const memories = (() => {
          if (filters.sort_field !== 'slide_order') return response.memories
          return response.memories
            .map((memory, index) => ({ memory, index }))
            .sort((a, b) => {
              const aVal = Number(a.memory.metadata?.['slide-order'])
              const bVal = Number(b.memory.metadata?.['slide-order'])
              const aNum = Number.isFinite(aVal) ? aVal : Number.POSITIVE_INFINITY
              const bNum = Number.isFinite(bVal) ? bVal : Number.POSITIVE_INFINITY
              if (aNum !== bNum) return aNum - bNum
              return a.index - b.index
            })
            .map((item) => item.memory)
        })()

        setMemories(memories)
        setPagination(response.pagination)
        setMissingMemoryCount(0)
      } catch (err: any) {
        if (cancelled) return
        setMemoriesError(err?.message || 'Failed to load memories')
        setMemories([])
        setPagination(null)
        setMissingMemoryCount(0)
      }
    }

    setIsLoadingMemories(true)
    setMemoriesError(null)

    const load = async () => {
      if (memoryIdFilter.length > 0) {
        await loadByIds()
      } else {
        await loadBySearch()
      }

      if (!cancelled) {
        setIsLoadingMemories(false)
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [projectId, query, filters, pageSize, currentPage, refreshKey, memoryIdFilter])

  // Reset to page 1 when filters or query change
  const handleQueryChange = useCallback((newQuery: string) => {
    setQuery(newQuery)
    setCurrentPage(1)
    setMissingMemoryCount(0)
    const ids = parseMemoryIdQuery(newQuery)
    setMemoryIdFilter(ids ?? [])
  }, [])

  const handleFiltersChange = useCallback((newFilters: ProjectFilterValues) => {
    setFilters(newFilters)
    setCurrentPage(1)
  }, [])

  const handlePageSizeChange = (newSize: number) => {
    setPageSize(newSize)
    setCurrentPage(1)
  }

  const handleSummaryItemClick = useCallback((title: string, _memories: Memory[]) => {
    // Set filters based on summary section clicked
    if (title === 'Todos In Progress') {
      setFilters((prev) => ({ ...prev, type: 'assistant-todo', subtype: '', status: 'in_progress' }))
    } else if (title === 'Recent Decisions') {
      setFilters((prev) => ({ ...prev, type: 'decision', subtype: '', status: '' }))
    } else if (title === 'Recent Patterns') {
      // pattern is a subtype of knowledge
      setFilters((prev) => ({ ...prev, type: 'knowledge', subtype: 'pattern', status: '' }))
    } else if (title === 'Recent Context') {
      // context is a subtype of knowledge
      setFilters((prev) => ({ ...prev, type: 'knowledge', subtype: 'context', status: '' }))
    } else if (title === 'Rules') {
      setFilters((prev) => ({ ...prev, type: 'assistant-rule', subtype: '', status: '' }))
    } else if (title === 'Pinned') {
      setFilters((prev) => ({ ...prev, pinned: prev.pinned === 'true' ? '' : 'true' }))
    }
    // Clear search query when using summary filters
    handleQueryChange('')
  }, [handleQueryChange])

  const handleSummaryShowInResults = useCallback(
    (memories: Memory[]) => {
      if (!memories || memories.length === 0) return
      const ids = memories.map((memory) => memory.id)
      handleQueryChange(ids.join(', '))
      setActiveSummary(null)
    },
    [handleQueryChange]
  )

  const saveFiltersForReturn = useCallback(() => {
    if (typeof window === 'undefined') return
    window.sessionStorage.setItem(FILTER_KEY, JSON.stringify({ query, filters }))
    window.sessionStorage.setItem(RETURN_KEY, '1')
  }, [query, filters, FILTER_KEY, RETURN_KEY])

  const handleSummaryNavigate = useCallback(
    (memoryId: string) => {
      setActiveSummary(null)
      saveFiltersForReturn()
      setLocation(`/memories/${memoryId}`)
    },
    [setLocation, saveFiltersForReturn]
  )

  const handleMemoryClick = useCallback(
    async (memoryId: string) => {
      saveFiltersForReturn()
      const source = `/projects/${projectId}`
      // If all memories fit on current page, use them directly
      if (!pagination || (pagination.total_count ?? 0) <= memories.length) {
        const ids = memories.map((m) => m.id)
        setNavContext(ids, memoryId, source)
        setLocation(`/memories/${memoryId}`)
        return
      }
      // Otherwise fetch all IDs for full nav context
      try {
        const allResponse = await searchMemories({
          project_id: projectId,
          type: ((filters.subtype || filters.type) as any) || undefined,
          tag: filters.tag || undefined,
          handle: filters.handle || undefined,
          status: (filters.type || filters.subtype) ? filters.status || undefined : undefined,
          sort: (filters.sort_field === 'slide_order' ? 'created_at' : filters.sort_field) as any,
          order: filters.sort_dir === 'asc' ? 'asc' : undefined,
          compact: true,
          limit: pagination.total_count,
          offset: 0,
        })
        let allMemories = allResponse.memories
        // Apply client-side slide order sort if needed
        if (filters.sort_field === 'slide_order') {
          allMemories = allMemories
            .map((memory, index) => ({ memory, index }))
            .sort((a, b) => {
              const aVal = Number(a.memory.metadata?.['slide-order'])
              const bVal = Number(b.memory.metadata?.['slide-order'])
              const aNum = Number.isFinite(aVal) ? aVal : Number.POSITIVE_INFINITY
              const bNum = Number.isFinite(bVal) ? bVal : Number.POSITIVE_INFINITY
              if (aNum !== bNum) return aNum - bNum
              return a.index - b.index
            })
            .map((item) => item.memory)
        }
        const ids = allMemories.map((m) => m.id)
        setNavContext(ids, memoryId, source)
      } catch {
        // Fallback to current page
        const ids = memories.map((m) => m.id)
        setNavContext(ids, memoryId, source)
      }
      setLocation(`/memories/${memoryId}`)
    },
    [memories, pagination, filters, projectId, setLocation, saveFiltersForReturn]
  )

  const resetCreateForm = () => {
    setCreateTitle('')
    setCreateHandle('')
    setCreateContent('')
    setCreateType('user-note')
    setCreateSubtype('')
    setCreateTags([])
    setCreateExternalUrl('')
    setCreateError(null)
  }

  const openCreateWithType = (type: MemoryType) => {
    resetCreateForm()
    setCreateType(type)
    const children = typeHierarchy[type]
    setCreateSubtype(children && children.length > 0 ? children[0] : '')
    setShowCreate(true)
  }

  const resetEditForm = () => {
    const project = sessionContext?.project
    if (project) {
      setEditName(project.name || '')
      setEditHandle(project.handle || '')
      setEditDisplayName(project.display_name || '')
      setEditDescription(project.description || '')
      setEditPath(project.path || '')
    }
    setEditError(null)
  }

  const slugify = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')

  const isGoogleDocCreate = createType === 'google-doc'

  const doCreateMemory = useCallback(async () => {
    setCreateError(null)

    const externalUrl = createExternalUrl.trim()

    // Google Doc import path: use importGoogleDoc endpoint
    if (isGoogleDocCreate && externalUrl) {
      const match = externalUrl.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/)
      if (!match) {
        setCreateError('Invalid Google Doc URL')
        return
      }
      const docId = match[1]
      const tabMatch = externalUrl.match(/[?&#]tab=(t\.[a-zA-Z0-9_-]+)/)
      const tabId = tabMatch ? tabMatch[1] : undefined
      const effectiveType = (createSubtype || createType) as MemoryType

      setIsCreating(true)
      try {
        await importGoogleDoc(docId, {
          project_id: projectId,
          type: effectiveType,
          handle: createHandle.trim() || undefined,
          includeComments: true,
          tab_id: tabId,
        })
        setShowCreate(false)
        resetCreateForm()
        setQuery('')
        setMemoryIdFilter([])
        setFilters({
          type: '',
          subtype: '',
          tag: '',
          handle: '',
          status: '',
          sort_field: 'created_at',
          sort_dir: 'desc',
          date: '',
          date_from: '',
          date_to: '',
          date_range_mode: false,
          pinned: '',
          search_mode: '',
        })
        setCurrentPage(1)
        setRefreshKey((prev) => prev + 1)
        const context = await getSessionContext(projectId)
        setSessionContext(context)
      } catch (err: any) {
        let errorBody: any = null
        try {
          if (err.response?.json) errorBody = await err.response.json()
        } catch { /* ignore */ }
        const handle = errorBody?.handle
        if (handle && (err.message?.includes('handle') || errorBody?.error?.includes('handle'))) {
          setCreateError(`Handle "${handle}" already exists`)
          setCreateHandle(handle)
        } else {
          setCreateError(errorBody?.error || err.message || 'Failed to import Google Doc')
        }
      } finally {
        setIsCreating(false)
      }
      return
    }

    const title = createTitle.trim()
    const content = createContent.trim()
    const handleValue = createHandle.trim() || slugify(title)

    if (!title || !content) {
      setCreateError('Title and content are required.')
      return
    }

    if (!handleValue) {
      setCreateError('Provide a handle or a title that can generate one.')
      return
    }

    setIsCreating(true)
    try {
      const effectiveType = (createSubtype || createType) as MemoryType
      await createMemory(projectId, {
        handle: handleValue,
        title,
        content,
        type: effectiveType,
        parent_type: createSubtype ? createType : null,
        tags: createTags.length > 0 ? createTags : undefined,
      })
      setShowCreate(false)
      resetCreateForm()
      setQuery('')
      setMemoryIdFilter([])
      setFilters({
        type: '',
        subtype: '',
        tag: '',
        handle: '',
        status: '',
        sort_field: 'created_at',
        sort_dir: 'desc',
        date: '',
        date_from: '',
        date_to: '',
        date_range_mode: false,
        pinned: '',
        search_mode: '',
      })
      setCurrentPage(1)
      setRefreshKey((prev) => prev + 1)
      const context = await getSessionContext(projectId)
      setSessionContext(context)
    } catch (err: any) {
      setCreateError(err.message || 'Failed to create memory')
    } finally {
      setIsCreating(false)
    }
  }, [createTitle, createHandle, createContent, createType, createSubtype, createTags, createExternalUrl, isGoogleDocCreate, projectId, resetCreateForm])

  const handleCreateMemory = (event: Event) => {
    event.preventDefault()
    doCreateMemory()
  }

  const doSaveProject = useCallback(async () => {
    if (!sessionContext?.project) return

    const name = editName.trim()
    const handle = editHandle.trim()
    const displayName = editDisplayName.trim()
    const description = editDescription.trim()

    if (!name) {
      setEditError('Project name is required.')
      return
    }
    if (!handle) {
      setEditError('Project handle is required.')
      return
    }
    const current = sessionContext.project
    const path = editPath.trim()
    const updates: {
      name?: string
      handle?: string
      display_name?: string | null
      description?: string | null
      path?: string | null
    } = {}

    if (name !== current.name) updates.name = name
    if (handle !== current.handle) updates.handle = handle
    const currentDisplay = current.display_name || ''
    if (displayName !== currentDisplay) {
      updates.display_name = displayName ? displayName : null
    }
    const currentDescription = current.description || ''
    if (description !== currentDescription) {
      updates.description = description ? description : null
    }
    const currentPath = current.path || ''
    if (path !== currentPath) {
      updates.path = path ? path : null
    }

    if (Object.keys(updates).length === 0) {
      setIsEditingProject(false)
      return
    }

    setIsSavingProject(true)
    setEditError(null)
    try {
      await updateProject(projectId, updates)
      const context = await getSessionContext(projectId)
      setSessionContext(context)
      setIsEditingProject(false)
    } catch (err: any) {
      setEditError(err.message || 'Failed to update project')
    } finally {
      setIsSavingProject(false)
    }
  }, [sessionContext?.project, editName, editHandle, editDisplayName, editDescription, editPath, projectId])

  const handleSaveProject = (event: Event) => {
    event.preventDefault()
    doSaveProject()
  }

  const cancelEditingProject = useCallback(() => {
    if (sessionContext?.project) {
      setEditName(sessionContext.project.name)
      setEditHandle(sessionContext.project.handle || '')
      setEditDisplayName(sessionContext.project.display_name || '')
      setEditDescription(sessionContext.project.description || '')
      setEditPath(sessionContext.project.path || '')
    }
    setEditError(null)
    setIsEditingProject(false)
  }, [sessionContext?.project])

  // Keyboard shortcuts for project editing
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // CMD+E to enter edit mode (when not already editing and project is loaded)
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key === 'e' &&
        !isEditingProject &&
        sessionContext?.project
      ) {
        event.preventDefault()
        setIsEditingProject(true)
        resetEditForm()
        return
      }

      if (!isEditingProject) return

      if (event.key === 'Escape') {
        event.preventDefault()
        cancelEditingProject()
      } else if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault()
        doSaveProject()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isEditingProject, doSaveProject, cancelEditingProject, sessionContext?.project, resetEditForm])

  // Keyboard shortcuts for creating memory
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!showCreate) return

      if (event.key === 'Escape') {
        event.preventDefault()
        setShowCreate(false)
        resetCreateForm()
      } else if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault()
        doCreateMemory()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showCreate, doCreateMemory, resetCreateForm])

  const handleDeleteProject = async () => {
    if (!sessionContext?.project) return

    setIsDeletingProject(true)
    setEditError(null)
    try {
      await deleteProject(projectId)
      setLocation('/projects')
    } catch (err: any) {
      setEditError(err.message || 'Failed to delete project')
      setIsDeletingProject(false)
    } finally {
      setShowDeleteConfirm(false)
    }
  }

  // Handle sync rules + knowledge - uses project.path, shows flash message for result
  // "user" project syncs to home directories, no path needed
  const handleSyncRulesClick = async () => {
    const projectHandle = sessionContext?.project?.handle
    const projectPath = sessionContext?.project?.path
    if (!projectHandle) return

    if (!projectPath && projectHandle !== 'user') {
      setSyncRulesFlash({ type: 'error', message: 'Set project path first' })
      setTimeout(() => setSyncRulesFlash(null), 3000)
      return
    }

    setIsSyncingRules(true)
    setSyncRulesFlash(null)
    try {
      const [rulesResult, knowledgeResult] = await Promise.all([
        syncProjectRules(projectHandle),
        syncProjectKnowledge(projectId),
      ])
      const rulesUpdated = rulesResult.results.filter((r) => r.action !== 'unchanged').length
      const knowledgeUpdated = knowledgeResult.results.filter((r) => r.action !== 'unchanged').length
      const parts: string[] = []
      if (rulesUpdated > 0) parts.push(`${rulesResult.rulesCount} rules`)
      if (knowledgeUpdated > 0) parts.push(`knowledge`)
      setSyncRulesFlash({
        type: 'success',
        message: parts.length > 0 ? `Synced ${parts.join(', ')}` : 'Already up to date',
      })
    } catch (err: any) {
      setSyncRulesFlash({ type: 'error', message: err.message || 'Sync failed' })
    } finally {
      setIsSyncingRules(false)
      setTimeout(() => setSyncRulesFlash(null), 3000)
    }
  }

  const handleCopyId = async () => {
    if (!sessionContext?.project?.id) return
    try {
      await navigator.clipboard.writeText(sessionContext.project.id)
      setCopiedId(true)
      setTimeout(() => setCopiedId(false), 2000)
    } catch {
      // Clipboard API failed
    }
  }

  const handleImportFile = (e: Event) => {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const content = event.target?.result as string
      // Extract title from filename (remove .md extension)
      const title = file.name.replace(/\.(md|markdown)$/i, '')

      setCreateTitle(title)
      setCreateContent(content)
      setShowCreate(true)
    }
    reader.readAsText(file)

    // Reset input so same file can be imported again
    input.value = ''
  }

  // Google Doc import handler
  const handleImportGoogleDoc = async () => {
    if (!googleDocUrl.trim() || !sessionContext?.project?.id) return

    // Extract doc ID from URL
    const match = googleDocUrl.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/)
    if (!match) {
      setGoogleDocError('Invalid Google Doc URL')
      return
    }
    const docId = match[1]
    const tabMatch = googleDocUrl.match(/[?&#]tab=(t\.[a-zA-Z0-9_-]+)/)
    const tabId = tabMatch ? tabMatch[1] : undefined

    setIsImportingGoogleDoc(true)
    setGoogleDocError(null)

    try {
      const result = await importGoogleDoc(docId, {
        project_id: sessionContext.project.id,
        type: googleDocType,
        handle: googleDocHandle.trim() || undefined,
        includeComments: true,
        tab_id: tabId,
      })

      // Close modal and refresh
      setShowGoogleDocImport(false)
      setGoogleDocUrl('')
      setGoogleDocHandle('')
      setGoogleDocType('user-note')
      setRefreshKey((k) => k + 1)
      showToast(`Imported: ${result.memory.title}`)
    } catch (err: any) {
      // Try to parse response body for additional info
      let errorBody: any = null
      try {
        if (err.response?.json) {
          errorBody = await err.response.json()
        }
      } catch {
        // Ignore parse errors
      }

      // Show the conflicting handle if available
      const handle = errorBody?.handle
      if (handle && (err.message?.includes('handle') || errorBody?.error?.includes('handle'))) {
        setGoogleDocError(`Handle "${handle}" already exists`)
        setGoogleDocHandle(handle)
      } else {
        setGoogleDocError(errorBody?.error || err.message || 'Failed to import Google Doc')
      }
    } finally {
      setIsImportingGoogleDoc(false)
    }
  }

  // Context menu handlers
  const handleContextMenu = useCallback((e: MouseEvent, memory: Memory) => {
    e.preventDefault()
    setContextMenu({ memory, x: e.clientX, y: e.clientY })
  }, [])

  const handleDeleteMemory = useCallback(async () => {
    if (!deleteTarget) return

    setIsDeletingMemory(true)
    try {
      await deleteMemory(projectId, deleteTarget.id)
      setDeleteTarget(null)
      setRefreshKey((k) => k + 1)
    } catch (err: any) {
      console.error('Failed to delete memory:', err.message)
    } finally {
      setIsDeletingMemory(false)
    }
  }, [deleteTarget, projectId])

  // Calculate pagination info
  const totalPages = pagination?.total_count ? Math.ceil(pagination.total_count / pageSize) : 1
  const canGoPrev = currentPage > 1
  const canGoNext = pagination?.has_more ?? false

  // Compute summary stats from session context
  const todosInProgress = sessionContext?.todos?.in_progress?.length ?? 0
  const recentDecisions = sessionContext?.recent_decisions?.length ?? 0
  const recentPatterns = sessionContext?.recent_patterns?.length ?? 0
  const recentContext = sessionContext?.recent_context?.length ?? 0
  const isMemoryIdQuery = memoryIdFilter.length > 0

  const summarySections = [
    {
      label: 'Todos In Progress',
      count: todosInProgress,
      memories: sessionContext?.todos?.in_progress ?? [],
    },
    {
      label: 'Recent Decisions',
      count: recentDecisions,
      memories: sessionContext?.recent_decisions ?? [],
    },
    {
      label: 'Recent Patterns',
      count: recentPatterns,
      memories: sessionContext?.recent_patterns ?? [],
    },
    {
      label: 'Recent Context',
      count: recentContext,
      memories: sessionContext?.recent_context ?? [],
    },
    {
      label: 'Rules',
      count: rulesCount,
      memories: [],
    },
    {
      label: 'Pinned',
      count: 1, // always clickable
      memories: [],
    },
  ]

  return (
    <div class={styles.page}>
      <div class={styles.header}>
        <div class={styles.headerTop}>
          <h1 class={styles.title}>
            {projectTitle}
          </h1>
        </div>
        {sessionContext?.project?.description && (
          <p class={styles.description}>{sessionContext.project.description}</p>
        )}
      </div>

      {isEditingProject && (
        <form class={styles.createPanel} onSubmit={handleSaveProject}>
          <div class={styles.createRow}>
            <label class={styles.createLabel} htmlFor="edit-project-name">
              Name
            </label>
            <input
              id="edit-project-name"
              class={styles.createInput}
              type="text"
              value={editName}
              onInput={(e) => setEditName((e.target as HTMLInputElement).value)}
              placeholder="Project name"
            />
          </div>
          <div class={styles.createRow}>
            <label class={styles.createLabel} htmlFor="edit-project-handle">
              Handle
            </label>
            <input
              id="edit-project-handle"
              class={styles.createInput}
              type="text"
              value={editHandle}
              onInput={(e) => setEditHandle((e.target as HTMLInputElement).value)}
              placeholder="project-handle"
            />
          </div>
          <div class={styles.createRow}>
            <label class={styles.createLabel} htmlFor="edit-project-display-name">
              Display name
            </label>
            <input
              id="edit-project-display-name"
              class={styles.createInput}
              type="text"
              value={editDisplayName}
              onInput={(e) =>
                setEditDisplayName((e.target as HTMLInputElement).value)
              }
              placeholder="Optional"
            />
          </div>
          <div class={styles.createRow}>
            <label class={styles.createLabel} htmlFor="edit-project-description">
              Description
            </label>
            <textarea
              id="edit-project-description"
              class={styles.createTextarea}
              value={editDescription}
              onInput={(e) =>
                setEditDescription((e.target as HTMLTextAreaElement).value)
              }
              placeholder="Optional"
            />
          </div>
          <div class={styles.createRow}>
            <label class={styles.createLabel} htmlFor="edit-project-path">
              Path
            </label>
            <input
              id="edit-project-path"
              class={styles.createInput}
              type="text"
              value={editPath}
              onInput={(e) => setEditPath((e.target as HTMLInputElement).value)}
              placeholder="~/projects/my-project"
            />
          </div>
          {editError && <div class={styles.createError}>{editError}</div>}
          <div class={styles.createActions}>
            <button
              class={styles.deleteButton}
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              disabled={isSavingProject || isDeletingProject}
            >
              Delete
            </button>
            <button
              class={styles.cancelButton}
              type="button"
              onClick={() => {
                setIsEditingProject(false)
                resetEditForm()
              }}
              disabled={isSavingProject || isDeletingProject}
            >
              Cancel
            </button>
            <button
              class={styles.submitButton}
              type="submit"
              disabled={isSavingProject || isDeletingProject}
            >
              {isSavingProject ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      )}

      {/* Summary Section */}
      {isLoadingContext ? (
        <div class={clsx(styles.summary, styles.skeleton, styles.summarySkeleton)}>
          <div class={clsx(styles.skeletonBar, styles.skeletonTitle)} style={{ width: '30%' }} />
        </div>
      ) : contextError ? (
        <div class={styles.error}>{contextError}</div>
      ) : sessionContext ? (
        <div class={styles.summary}>
          {/* Row 1: Project path + utility actions */}
          <div class={styles.metaRow}>
            <span class={styles.projectPath}>
              {sessionContext.project?.path || ''}
            </span>
            {syncRulesFlash && (
              <span
                class={
                  syncRulesFlash.type === 'success' ? styles.flashSuccess : styles.flashError
                }
              >
                {syncRulesFlash.message}
              </span>
            )}
            {sessionContext?.project && (
              <div class={styles.summaryActions}>
                <button
                  class={styles.actionBtn}
                  type="button"
                  onClick={handleCopyId}
                  title="Copy project ID"
                >
                  {copiedId ? <Check size={13} /> : <Copy size={13} />}
                </button>
                <button
                  class={styles.actionBtn}
                  type="button"
                  onClick={handleSyncRulesClick}
                  title={
                    sessionContext.project.path || sessionContext.project.handle === 'user'
                      ? 'Sync rules & knowledge'
                      : 'Set project path first'
                  }
                  disabled={isSyncingRules}
                >
                  <Repeat size={13} class={isSyncingRules ? styles.spinning : ''} />
                </button>
                <button
                  class={styles.actionBtn}
                  type="button"
                  onClick={() => {
                    setIsEditingProject(true)
                    resetEditForm()
                  }}
                  title="Edit project"
                >
                  <Pencil size={13} />
                </button>
              </div>
            )}
          </div>

          {/* Row 2: Labeled nav buttons */}
          {sessionContext?.project && (
            <div class={styles.navRow}>
              <Link href={`/projects/${projectId}/graph`} class={styles.navBtn}>
                <Network size={13} /> Graph
              </Link>
              <Link href={`/projects/${projectId}/collections`} class={styles.navBtn}>
                <Layers size={13} /> Collections
              </Link>
              <Link href={`/projects/${projectId}/files`} class={styles.navBtn}>
                <Paperclip size={13} /> Files
              </Link>
              <Link href={`/projects/${projectId}/configs`} class={styles.navBtn}>
                <FileText size={13} /> Configs
              </Link>
              <Link href={`/projects/${projectId}/sessions`} class={styles.navBtn}>
                <ScrollText size={13} /> Sessions
              </Link>
              <Link href={`/projects/${projectId}/plans`} class={styles.navBtn}>
                <ClipboardList size={13} /> Plans
              </Link>
              <Link href={`/projects/${projectId}/memory-files`} class={styles.navBtn}>
                <Brain size={13} /> Memory Files
              </Link>
              {sessionContext.project.path && (
                <Link href={`/projects/${projectId}/diff`} class={styles.navBtn}>
                  <GitBranch size={13} /> Diff
                </Link>
              )}
              {sessionContext.project.path && (
                <Link href={`/projects/${projectId}/agents`} class={styles.navBtn}>
                  <Bot size={13} /> Agents
                </Link>
              )}
            </div>
          )}

          {/* Row 3: Quick filter chips */}
          <div class={styles.filterRow}>
            <span class={styles.filterLabel}>Quick filters</span>
            {summarySections.map((section) => {
              const isClickable = section.count > 0
              const colorClass = section.label === 'Todos In Progress' ? styles.filterTodo
                : section.label === 'Recent Decisions' ? styles.filterDecision
                : section.label === 'Recent Patterns' ? styles.filterPattern
                : section.label === 'Recent Context' ? styles.filterContext
                : section.label === 'Rules' ? styles.filterRule
                : section.label === 'Pinned' ? styles.filterPinned
                : ''
              return (
                <button
                  key={section.label}
                  type="button"
                  class={clsx(styles.filterChip, colorClass, !isClickable && styles.filterChipDisabled)}
                  onClick={() => isClickable && handleSummaryItemClick(section.label, section.memories)}
                  disabled={!isClickable}
                  data-testid={`project-page--summary-${section.label.toLowerCase().replace(/\s+/g, '-')}`}
                >
                  <span class={styles.filterDot} />
                  <span class={styles.filterChipLabel}>{
                    section.label === 'Todos In Progress' ? 'Todos'
                    : section.label === 'Recent Decisions' ? 'Decisions'
                    : section.label === 'Recent Patterns' ? 'Patterns'
                    : section.label === 'Recent Context' ? 'Context'
                    : section.label
                  }</span>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      {/* Search and Filters */}
      <div class={styles.searchSection}>
        <SearchBar
          value={query}
          onChange={handleQueryChange}
          placeholder="Search memories or paste memory IDs (comma-separated or prefix with id:)"
          searchMode={filters.search_mode}
          onSearchModeChange={(mode) => setFilters((prev) => ({ ...prev, search_mode: mode }))}
        />
        {isMemoryIdQuery && (
          <div class={styles.searchHint}>
            <div>
              Filtering by {memoryIdFilter.length} memory ID{memoryIdFilter.length !== 1 ? 's' : ''}.
              {missingMemoryCount > 0 && (
                <span class={styles.searchHintWarning}>
                  {' '}
                  {missingMemoryCount} ID{missingMemoryCount > 1 ? 's are' : ' is'} missing.
                </span>
              )}
            </div>
            <button
              type="button"
              class={styles.searchHintButton}
              onClick={() => handleQueryChange('')}
            >
              Clear
            </button>
          </div>
        )}
      </div>
      <ProjectFiltersPanel
        projectId={projectId}
        filters={filters}
        onChange={handleFiltersChange}
        typeOptions={topLevelTypeOptions || allTypeOptions || []}
        typeHierarchy={typeHierarchy}
      />

      {showCreate && (
        <form class={styles.createPanel} onSubmit={handleCreateMemory}>
          <div class={styles.createRow}>
            <label class={styles.createLabel} htmlFor="create-title">
              Title
            </label>
            <input
              id="create-title"
              class={styles.createInput}
              type="text"
              value={createTitle}
              onInput={(e) =>
                setCreateTitle((e.target as HTMLInputElement).value)
              }
              placeholder={isGoogleDocCreate ? 'Auto-filled from document' : 'Memory title'}
            />
          </div>
          <div class={styles.createRow}>
            <label class={styles.createLabel} htmlFor="create-handle">
              Handle
            </label>
            <input
              id="create-handle"
              class={styles.createInput}
              type="text"
              value={createHandle}
              onInput={(e) =>
                setCreateHandle((e.target as HTMLInputElement).value)
              }
              placeholder="Optional (auto-generated from title)"
            />
          </div>
          <div class={styles.createRow}>
            <label class={styles.createLabel} htmlFor="create-type">
              Type
            </label>
            <select
              id="create-type"
              class={styles.createSelect}
              value={createType}
              onChange={(e) => {
                const nextType = (e.target as HTMLSelectElement).value as MemoryType
                setCreateType(nextType)
                const children = typeHierarchy[nextType]
                setCreateSubtype(children && children.length > 0 ? children[0] : '')
              }}
            >
              {(topLevelTypeOptions || allTypeOptions || MEMORY_TYPES).map((type) => (
                <option key={type} value={type}>
                  {getTypeLabel(type)}
                </option>
              ))}
            </select>
          </div>
          {(typeHierarchy[createType]?.length ?? 0) > 0 && (
            <div class={styles.createRow}>
              <label class={styles.createLabel} htmlFor="create-subtype">
                Subtype
              </label>
              <select
                id="create-subtype"
                class={styles.createSelect}
                value={createSubtype}
                onChange={(e) => setCreateSubtype((e.target as HTMLSelectElement).value)}
              >
                {typeHierarchy[createType]?.map((type) => (
                  <option key={type} value={type}>
                    {getTypeLabel(type)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {isGoogleDocCreate && (
            <div class={styles.createRow}>
              <label class={styles.createLabel} htmlFor="create-external-url">
                External URL
              </label>
              <input
                id="create-external-url"
                class={styles.createInput}
                type="url"
                value={createExternalUrl}
                onInput={(e) =>
                  setCreateExternalUrl((e.target as HTMLInputElement).value)
                }
                placeholder="https://docs.google.com/document/d/..."
              />
            </div>
          )}
          <div class={styles.createRow}>
            <label class={styles.createLabel} htmlFor="create-tags">
              Tags
            </label>
            <TagInput
              tags={createTags}
              onChange={setCreateTags}
              placeholder="Add tags (press Enter or comma)"
            />
          </div>
          <div class={styles.createRow}>
            <label class={styles.createLabel} htmlFor="create-content">
              Content
            </label>
            <textarea
              id="create-content"
              class={styles.createTextarea}
              value={createContent}
              onInput={(e) =>
                setCreateContent((e.target as HTMLTextAreaElement).value)
              }
              placeholder={isGoogleDocCreate ? 'Auto-filled from document' : 'Describe the memory...'}
            />
          </div>
          {createError && <div class={styles.createError}>{createError}</div>}
          <div class={styles.createActions}>
            <button
              class={styles.cancelButton}
              type="button"
              onClick={() => {
                setShowCreate(false)
                resetCreateForm()
              }}
              disabled={isCreating}
            >
              Cancel
            </button>
            <button class={styles.submitButton} type="submit" disabled={isCreating}>
              {isCreating ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      )}

      <div class={styles.divider} />

      {/* Error state */}
      {memoriesError && <div class={styles.error}>{memoriesError}</div>}

      <div class={styles.meta}>
        <span>
          {isMemoryIdQuery
            ? `Showing ${memories.length} selected memor${memories.length !== 1 ? 'ies' : 'y'}`
            : pagination
              ? `Showing ${memories.length} of ${pagination.total_count} memor${pagination.total_count !== 1 ? 'ies' : 'y'}`
              : ''}
        </span>
        <div class={styles.createButtonContainer}>
          <div class={styles.quickTags}>
            <button
              type="button"
              class={styles.quickTag}
              onClick={() => openCreateWithType('assistant-todo')}
            >
              Assistant Todo
            </button>
            <button
              type="button"
              class={styles.quickTag}
              onClick={() => openCreateWithType('assistant-rule')}
            >
              Assistant Rule
            </button>
            <button
              type="button"
              class={styles.quickTag}
              onClick={() => openCreateWithType('user-note')}
            >
              User Note
            </button>
            <button
              type="button"
              class={clsx(styles.quickTag, styles.quickTagAccent)}
              onClick={() => {
                if (googleDocSubtypes.length > 0) {
                  setGoogleDocType(googleDocSubtypes[0] as MemoryType)
                }
                setShowGoogleDocImport(true)
              }}
            >
              <FileSpreadsheet size={12} />
              Google Doc
            </button>
          </div>
          <input
            ref={importInputRef}
            type="file"
            accept=".md,.markdown,text/markdown"
            onChange={handleImportFile}
            style={{ display: 'none' }}
          />
          <div class={styles.buttonGroup}>
            <button
              class={styles.createButton}
              type="button"
              onClick={() => setShowCreate((prev) => !prev)}
            >
              <Plus size={16} />
              Create
            </button>
            <button
              class={styles.createButton}
              type="button"
              onClick={() => importInputRef.current?.click()}
            >
              <FileUp size={16} />
              Import
            </button>
          </div>
        </div>
      </div>

      {/* Loading state */}
      {isLoadingMemories ? (
        <div class={styles.list}>
          {Array.from({ length: 5 }).map((_, i) => (
            <MemorySkeleton key={i} />
          ))}
        </div>
      ) : memories.length === 0 ? (
        <div class={styles.empty}>
          <FolderOpen class={styles.emptyIcon} size={48} />
          <h2 class={styles.emptyTitle}>No memories found</h2>
          <p class={styles.emptyText}>
            {query || filters.type || filters.subtype || filters.tag || filters.status || filters.date || filters.date_from || filters.date_to
              ? 'Try adjusting your search query or filters.'
              : 'This project has no memories yet.'}
          </p>
        </div>
      ) : (
        <>
          <div class={styles.list}>
            {memories.map((memory) => (
              <MemoryCard
                key={memory.id}
                memory={memory}
                onClick={() => handleMemoryClick(memory.id)}
                onContextMenu={(e) => handleContextMenu(e, memory)}
              />
            ))}
          </div>

          {/* Pagination controls */}
          {pagination && !isMemoryIdQuery && (pagination.total_count ?? 0) > PAGE_SIZE_OPTIONS[0] && (
            <div class={styles.pagination} data-testid="project-page--pagination">
              <div class={styles.paginationControls}>
                <button
                  class={styles.paginationButton}
                  onClick={() => setCurrentPage((p) => p - 1)}
                  disabled={!canGoPrev}
                >
                  Previous
                </button>
                <span class={styles.paginationInfo}>
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  class={styles.paginationButton}
                  onClick={() => setCurrentPage((p) => p + 1)}
                  disabled={!canGoNext}
                >
                  Next
                </button>
              </div>

              <div class={styles.pageSizeSelect}>
                <label class={styles.pageSizeLabel}>Per page:</label>
                <select
                  class={styles.pageSizeDropdown}
                  value={pageSize}
                  data-testid="project-page--page-size"
                  onChange={(e) =>
                    handlePageSizeChange(Number((e.target as HTMLSelectElement).value))
                  }
                >
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </>
      )}

      {activeSummary && (
        <SummaryMemoriesModal
          title={activeSummary.title}
          memories={activeSummary.memories}
          onClose={() => setActiveSummary(null)}
          onNavigate={handleSummaryNavigate}
          onShowInResults={() => handleSummaryShowInResults(activeSummary.memories)}
        />
      )}

      {showDeleteConfirm && (
        <ConfirmModal
          title="Delete Project"
          message="Delete this project? This cannot be undone."
          confirmLabel={isDeletingProject ? 'Deleting...' : 'Delete'}
          variant="danger"
          onConfirm={handleDeleteProject}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {contextMenu && (
        <MemoryContextMenu
          memory={contextMenu.memory}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          typeOptions={topLevelTypeOptions || allTypeOptions || typeOptions || []}
          onChangeType={async (type) => {
            const mem = contextMenu.memory
            setContextMenu(null)
            try {
              const nextStatus = await resolveStatusForType(mem.project_id, type, mem.status)
              await updateMemory(mem.project_id, mem.id, { type, parent_type: null, status: nextStatus })
              setRefreshKey((k) => k + 1)
            } catch (err: any) {
              console.error('Failed to change type:', err.message)
            }
          }}
          onChangeStatus={async (status) => {
            const mem = contextMenu.memory
            setContextMenu(null)
            try {
              await updateMemory(mem.project_id, mem.id, { status })
              setRefreshKey((k) => k + 1)
            } catch (err: any) {
              console.error('Failed to change status:', err.message)
            }
          }}
          onTogglePin={async (pin) => {
            const mem = contextMenu.memory
            try {
              if (pin) {
                await setMemoryMetadataField(mem.id, 'is-pinned', 'true')
              } else {
                await deleteMemoryMetadataField(mem.id, 'is-pinned')
              }
              setRefreshKey((k) => k + 1)
              showToast(pin ? 'Pinned' : 'Unpinned')
            } catch (err: any) {
              showToast(err.message || 'Failed to update pin')
            }
          }}
          onAddToCollection={() => {
            const mem = contextMenu.memory
            setContextMenu(null)
            setAddToCollectionTarget(mem)
          }}
          onDelete={() => {
            setDeleteTarget(contextMenu.memory)
            setContextMenu(null)
          }}
          onClose={() => setContextMenu(null)}
          onShowToast={showToast}
        />
      )}

      {addToCollectionTarget && (
        <AddToCollectionModal
          memoryId={addToCollectionTarget.id}
          projectId={addToCollectionTarget.project_id}
          onClose={() => setAddToCollectionTarget(null)}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete Memory"
          message={`Delete "${deleteTarget.title}"? This cannot be undone.`}
          confirmLabel={isDeletingMemory ? 'Deleting...' : 'Delete'}
          variant="danger"
          onConfirm={handleDeleteMemory}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Google Doc Import Modal */}
      {showGoogleDocImport && (
        <div class={styles.modalOverlay} onClick={() => setShowGoogleDocImport(false)}>
          <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div class={styles.modalHeader}>
              <h3>Import from Google Doc</h3>
              <button
                class={styles.modalClose}
                onClick={() => setShowGoogleDocImport(false)}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div class={styles.modalBody}>
              <div class={styles.formGroup}>
                <label class={styles.formLabel}>Google Doc URL</label>
                <input
                  type="text"
                  class={styles.formInput}
                  value={googleDocUrl}
                  onInput={(e) => setGoogleDocUrl((e.target as HTMLInputElement).value)}
                  placeholder="https://docs.google.com/document/d/..."
                  autoFocus
                />
              </div>
              <div class={styles.formGroup}>
                <label class={styles.formLabel}>Memory Type</label>
                {googleDocSubtypes.length > 0 ? (
                  <select
                    class={styles.formSelect}
                    value={googleDocType}
                    onChange={(e) => setGoogleDocType((e.target as HTMLSelectElement).value as MemoryType)}
                  >
                    {googleDocSubtypes.map((t) => (
                      <option key={t} value={t}>
                        {getTypeLabel(t)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p class={styles.formHint}>
                    No Google Doc subtypes configured. Go to{' '}
                    <a href="/settings/custom-types/new" class={styles.formLink}>
                      Custom Types
                    </a>{' '}
                    to create one with "google-doc" as the parent type.
                  </p>
                )}
              </div>
              <div class={styles.formGroup}>
                <label class={styles.formLabel}>Handle (optional)</label>
                <input
                  type="text"
                  class={styles.formInput}
                  value={googleDocHandle}
                  onInput={(e) => setGoogleDocHandle((e.target as HTMLInputElement).value)}
                  placeholder="Auto-generated from title if empty"
                />
              </div>
              {googleDocError && <div class={styles.formError}>{googleDocError}</div>}
            </div>
            <div class={styles.modalFooter}>
              <button
                class={styles.cancelButton}
                onClick={() => setShowGoogleDocImport(false)}
                disabled={isImportingGoogleDoc}
              >
                Cancel
              </button>
              <button
                class={styles.primaryButton}
                onClick={handleImportGoogleDoc}
                disabled={isImportingGoogleDoc || !googleDocUrl.trim() || googleDocSubtypes.length === 0}
              >
                {isImportingGoogleDoc ? 'Importing...' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}

      {navPosition && (
        <div class={styles.bottomNav}>
          <button
            class={styles.navButton}
            onClick={navigatePrev}
            title="Previous project (Left arrow)"
            aria-label="Previous project"
          >
            <ChevronLeft size={18} />
          </button>
          <span class={styles.navPosition} data-testid="nav-position">
            {navPosition.current} of {navPosition.total}
          </span>
          <button
            class={styles.navButton}
            onClick={navigateNext}
            title="Next project (Right arrow)"
            aria-label="Next project"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      )}

    </div>
  )
}

function MemorySkeleton() {
  return (
    <div class={styles.skeleton}>
      <div class={styles.skeletonHeader}>
        <div class={clsx(styles.skeletonBar, styles.skeletonBadge)} />
        <div class={clsx(styles.skeletonBar, styles.skeletonBadge)} />
      </div>
      <div class={clsx(styles.skeletonBar, styles.skeletonTitle)} />
      <div class={clsx(styles.skeletonBar, styles.skeletonExcerpt)} />
      <div class={styles.skeletonTags}>
        <div class={clsx(styles.skeletonBar, styles.skeletonTag)} />
        <div class={clsx(styles.skeletonBar, styles.skeletonTag)} />
      </div>
    </div>
  )
}

interface SummaryMemoriesModalProps {
  title: string
  memories: Memory[]
  onClose: () => void
  onNavigate: (memoryId: string) => void
  onShowInResults: () => void
}

function SummaryMemoriesModal({
  title,
  memories,
  onClose,
  onNavigate,
  onShowInResults,
}: SummaryMemoriesModalProps) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  const handleBackdropClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget) {
      onClose()
    }
  }

  return (
    <div
      class={styles.modalBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label={`${title} memories`}
      onClick={handleBackdropClick}
    >
      <div class={styles.modal}>
        <div class={styles.modalHeader}>
          <div>
            <p class={styles.modalEyebrow}>Showing linked memories</p>
            <h3 class={styles.modalTitle}>
              {title}
              <span class={styles.modalCount}>({memories.length})</span>
            </h3>
          </div>
          <button class={styles.modalClose} type="button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div class={styles.modalList}>
          {memories.length === 0 ? (
            <p class={styles.modalEmpty}>No linked memories available.</p>
          ) : (
            memories.map((memory) => (
              <button
                key={memory.id}
                type="button"
                class={styles.modalItem}
                onClick={() => onNavigate(memory.id)}
              >
                <div>
                  <p class={styles.modalItemTitle}>{memory.title}</p>
                  <p class={styles.modalItemMeta}>
                    {getTypeLabel(memory.type)}
                    <span class={styles.modalItemDot} aria-hidden="true">
                      ·
                    </span>
                    {new Date(memory.updated_at).toLocaleDateString()}
                  </p>
                </div>
                <span class={styles.modalItemAction}>Open</span>
              </button>
            ))
          )}
        </div>

        <div class={styles.modalActions}>
          <button class={styles.modalSecondary} type="button" onClick={onClose}>
            Close
          </button>
          <button
            class={styles.modalPrimary}
            type="button"
            onClick={onShowInResults}
            disabled={memories.length === 0}
          >
            View in results
          </button>
        </div>
      </div>
    </div>
  )
}
