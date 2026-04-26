import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
import { useSearch, useLocation } from 'wouter-preact'
import { SearchBar, FiltersPanel, ResultsList, SessionResultsList, KeywordSessionResultsList, CommitResultsList, SlackResultsList, SourceCodeResultsList, DocResultsList, type FilterValues } from '../components/search'
import { MemoryContextMenu, AddToCollectionModal } from '../components/shared'
import { ConfirmModal, useToast } from '../components/ui'
import { useDocumentTitle } from '../hooks'
import { RotateCcw } from 'lucide-preact'
import {
  searchMemories,
  vectorSearch,
  searchSessions,
  searchSessionsKeyword,
  searchCommits,
  searchSlack,
  listSlackDocuments,
  searchSourceCode,
  getSourceCodeFacets,
  searchDocs,
  getDocsFacets,
  getProjects,
  getProjectMemoryTypes,
  getMemoryTypes,
  getMemory,
  updateMemory,
  deleteMemory,
  setMemoryMetadataField,
  deleteMemoryMetadataField,
} from '../lib/api'
import { getSettings, loadSettings } from '../lib/settings'
import type { Memory, Pagination, Project, MemoryType, SessionSearchResult, SessionKeywordSearchResult, CommitSearchResult, SlackSearchResult, SourceCodeSearchResult, DocSearchResult } from '../types'
import { setEditorDeepLink } from '../lib/editorDeepLink'
import { buildTypeHierarchy, uniqueTypeList } from '../lib/memoryTypes'
import styles from './SearchPage.module.css'

type SearchMode = 'keyword' | 'semantic'
type SearchCollection = 'memories' | 'sessions' | 'commits' | 'slack' | 'source' | 'docs'
type SourceDisplayMode = 'grouped' | 'all'
type SourcePerFileCount = 1 | 2 | 3 | 5

const SEMANTIC_ONLY_COLLECTIONS: SearchCollection[] = ['commits', 'source', 'docs']

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

function extractResultLine(metadata: Record<string, unknown> | null | undefined): number | null {
  if (!metadata) return null
  const keys = ['start_line', 'startLine', 'line_start', 'lineStart', 'line']
  for (const key of keys) {
    const raw = metadata[key]
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw)
    if (typeof raw === 'string') {
      const parsed = parseInt(raw, 10)
      if (Number.isFinite(parsed) && parsed > 0) return parsed
    }
  }
  return null
}

function extractResultColumn(metadata: Record<string, unknown> | null | undefined): number | null {
  if (!metadata) return null
  const keys = ['start_col', 'start_column', 'startCol', 'startColumn', 'column', 'col']
  for (const key of keys) {
    const raw = metadata[key]
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw)
    if (typeof raw === 'string') {
      const parsed = parseInt(raw, 10)
      if (Number.isFinite(parsed) && parsed > 0) return parsed
    }
  }
  return null
}

function buildSnippetNeedle(content: string): string {
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed) return trimmed.slice(0, 180)
  }
  return ''
}

export function SearchPage() {
  useDocumentTitle('Search')
  const searchString = useSearch()
  const [, setLocation] = useLocation()
  const { showToast } = useToast()

  // Parse URL params
  const params = new URLSearchParams(searchString)
  const urlQuery = params.get('q') || ''
  const urlMode = (params.get('mode') as SearchMode) || 'keyword'
  const urlCollection = (params.get('collection') as SearchCollection) || 'memories'
  const urlIncludeThinking = params.get('includeThinking') === 'true'
  const urlSourceDisplay = (params.get('sourceDisplay') as SourceDisplayMode) || 'grouped'
  const hasRangeParams = !!(params.get('date_from') || params.get('date_to'))
  const urlFilters: FilterValues = {
    project_ids: params.get('project_ids') || '',
    type: params.get('type') || '',
    subtype: params.get('subtype') || '',
    tag: params.get('tag') || '',
    handle: params.get('handle') || '',
    status: params.get('status') || '',
    // Searching defaults to relevance; otherwise default to newest. The API
    // picks relevance when `q` is present and `sort` is undefined, but the UI
    // always forwards whatever is in `filters.sort`, so we mirror that logic
    // here on URL parse.
    sort: params.get('sort') || (urlQuery ? 'relevance' : 'created_at'),
    date: hasRangeParams ? '' : params.get('date') || '',
    date_from: params.get('date_from') || '',
    date_to: params.get('date_to') || '',
    date_range_mode: hasRangeParams,
    pinned: params.get('pinned') || '',
  }
  if (!urlFilters.type && urlFilters.status) {
    urlFilters.status = ''
  }

  // Local state
  const [query, setQuery] = useState(urlQuery)
  const [searchMode, setSearchMode] = useState<SearchMode>(urlMode)
  const [searchCollection, setSearchCollection] = useState<SearchCollection>(urlCollection)
  const [includeThinking, setIncludeThinking] = useState(urlIncludeThinking)
  const [vectorEnabled, setVectorEnabled] = useState(false)
  const [filters, setFilters] = useState<FilterValues>(urlFilters)
  const [memories, setMemories] = useState<Memory[]>([])
  const [sessionResults, setSessionResults] = useState<SessionSearchResult[]>([])
  const [keywordSessionResults, setKeywordSessionResults] = useState<SessionKeywordSearchResult[]>([])
  const [commitResults, setCommitResults] = useState<CommitSearchResult[]>([])
  const [slackResults, setSlackResults] = useState<SlackSearchResult[]>([])
  const [slackFacets, setSlackFacets] = useState<{ channels: string[]; workspaces: string[] }>({
    channels: [],
    workspaces: [],
  })
  const [sourceCodeResults, setSourceCodeResults] = useState<SourceCodeSearchResult[]>([])
  const [sourceFacets, setSourceFacets] = useState<{ repos: string[]; languages: string[]; branches: string[] }>({
    repos: [],
    languages: [],
    branches: [],
  })
  const [docResults, setDocResults] = useState<DocSearchResult[]>([])
  const [docFacets, setDocFacets] = useState<{ projects: string[]; file_types: string[]; tags: string[] }>({
    projects: [],
    file_types: [],
    tags: [],
  })
  const [docProject, setDocProject] = useState(params.get('doc_project') || '')
  const [docFileType, setDocFileType] = useState(params.get('doc_file_type') || '')
  const [docTag, setDocTag] = useState(params.get('doc_tag') || '')
  const [repoFilter, setRepoFilter] = useState(params.get('repo') || '')
  const [slackChannel, setSlackChannel] = useState(params.get('channel') || '')
  const [slackWorkspace, setSlackWorkspace] = useState(params.get('workspace') || '')
  const [sourceLang, setSourceLang] = useState(params.get('language') || '')
  const [sourceBranch, setSourceBranch] = useState(params.get('branch') || '')
  const [sourceDisplayMode, setSourceDisplayMode] = useState<SourceDisplayMode>(urlSourceDisplay)
  const [sourcePerFile, setSourcePerFile] = useState<SourcePerFileCount>(1)
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [projectTypeOptions, setProjectTypeOptions] = useState<MemoryType[] | null>(null)
  const [projectAllTypeOptions, setProjectAllTypeOptions] = useState<MemoryType[] | null>(null)
  const [projectTopLevelTypeOptions, setProjectTopLevelTypeOptions] = useState<MemoryType[] | null>(null)
  const [globalTopLevelTypeOptions, setGlobalTopLevelTypeOptions] = useState<MemoryType[] | null>(null)
  const [projectTypeHierarchy, setProjectTypeHierarchy] = useState<Record<string, string[]>>({})
  const [memoryIdFilter, setMemoryIdFilter] = useState<string[]>([])
  const [missingMemoryCount, setMissingMemoryCount] = useState(0)
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ memory: Memory; x: number; y: number } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Memory | null>(null)
  const [isDeletingMemory, setIsDeletingMemory] = useState(false)
  const [addToCollectionTarget, setAddToCollectionTarget] = useState<Memory | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const resolveStatusForType = useCallback(
    async (projectId: string, type: MemoryType, currentStatus: string) => {
      try {
        const data = await getProjectMemoryTypes(projectId)
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

  // Update URL when query, mode, collection, or filters change
  const updateUrl = useCallback(
    (
      newQuery: string,
      newFilters: FilterValues,
      mode: SearchMode = searchMode,
      collection: SearchCollection = searchCollection,
      thinking: boolean = includeThinking,
      repo: string = repoFilter,
      channel: string = slackChannel,
      workspace: string = slackWorkspace,
      lang: string = sourceLang,
      branch: string = sourceBranch,
      sourceDisplay: SourceDisplayMode = sourceDisplayMode
    ) => {
      const params = new URLSearchParams()
      if (newQuery) params.set('q', newQuery)
      if (mode !== 'keyword') params.set('mode', mode)
      if (collection !== 'memories') params.set('collection', collection)
      if (thinking) params.set('includeThinking', 'true')
      if (repo) params.set('repo', repo)
      if (channel) params.set('channel', channel)
      if (workspace) params.set('workspace', workspace)
      if (lang) params.set('language', lang)
      if (branch) params.set('branch', branch)
      if (sourceDisplay !== 'grouped') params.set('sourceDisplay', sourceDisplay)
      if (newFilters.project_ids) params.set('project_ids', newFilters.project_ids)
      if (newFilters.type) params.set('type', newFilters.type)
      if (newFilters.subtype) params.set('subtype', newFilters.subtype)
      if (newFilters.tag) params.set('tag', newFilters.tag)
      if (newFilters.handle) params.set('handle', newFilters.handle)
      if ((newFilters.type || newFilters.subtype) && newFilters.status) params.set('status', newFilters.status)
      // Only include sort in URL when it diverges from the current context's
      // default: relevance while searching, created_at otherwise. Keeps shared
      // links clean.
      const defaultSort = newQuery ? 'relevance' : 'created_at'
      if (newFilters.sort && newFilters.sort !== defaultSort) {
        params.set('sort', newFilters.sort)
      }
      if (newFilters.pinned) params.set('pinned', newFilters.pinned)
      if (newFilters.date_range_mode) {
        if (newFilters.date_from) params.set('date_from', newFilters.date_from)
        if (newFilters.date_to) params.set('date_to', newFilters.date_to)
      } else if (newFilters.date) {
        params.set('date', newFilters.date)
      }

      const search = params.toString()
      setLocation(search ? `/search?${search}` : '/search', { replace: true })
    },
    [setLocation, searchMode, searchCollection, includeThinking, repoFilter, slackChannel, slackWorkspace, sourceLang, sourceBranch, sourceDisplayMode, sourcePerFile]
  )

  // Load settings to check if vector search is enabled
  useEffect(() => {
    loadSettings()
      .then(() => {
        setVectorEnabled(getSettings().vector.enabled)
      })
      .catch(() => {
        // Silently fail - vector toggle will be hidden
      })
  }, [])

  // Load projects for filter dropdown
  useEffect(() => {
    getProjects()
      .then(setProjects)
      .catch(() => {
        // Silently fail - projects dropdown will be empty
      })
  }, [])

  // Build repo name → project handle mapping for commit click-through
  // Repos use directory basename as name, which typically matches the project handle
  const repoProjectMap = useMemo(() => {
    const map: Record<string, string> = {}
    for (const p of projects) {
      // Direct handle match (most common)
      map[p.handle] = p.handle
      // Also map by path basename for repos that don't match handle
      if (p.path) {
        const basename = p.path.split('/').pop()
        if (basename && basename !== p.handle) {
          map[basename] = p.handle
        }
      }
    }
    return map
  }, [projects])

  // Build repo name → project root path mapping for source code click-through
  const repoRootMap = useMemo(() => {
    const map: Record<string, string> = {}
    for (const p of projects) {
      if (!p.path) continue
      map[p.handle] = p.path
      const basename = p.path.split('/').pop()
      if (basename) {
        map[basename] = p.path
      }
    }
    return map
  }, [projects])

  // Collect distinct repo names from current commit results for the filter dropdown
  const commitRepoNames = useMemo(() => {
    const repos = new Set<string>()
    for (const r of commitResults) {
      if (r.repo) repos.add(r.repo)
    }
    return Array.from(repos).sort()
  }, [commitResults])

  // Collect distinct repo names from source code results for the filter dropdown
  const sourceRepoNames = useMemo(() => {
    const repos = new Set<string>()
    for (const name of sourceFacets.repos) {
      if (name) repos.add(name)
    }
    for (const r of sourceCodeResults) {
      const repo = (r.metadata?.repoName as string) || (r.metadata?.repo as string) || ''
      if (repo) repos.add(repo)
    }
    return Array.from(repos).sort()
  }, [sourceCodeResults, sourceFacets.repos])

  // Collect distinct languages from source code results
  const sourceLangNames = useMemo(() => {
    const langs = new Set<string>()
    for (const name of sourceFacets.languages) {
      if (name) langs.add(name)
    }
    for (const r of sourceCodeResults) {
      if (r.language) langs.add(r.language)
    }
    return Array.from(langs).sort()
  }, [sourceCodeResults, sourceFacets.languages])

  // Collect distinct branches from source code results
  const sourceBranchNames = useMemo(() => {
    const branches = new Set<string>()
    for (const name of sourceFacets.branches) {
      if (name) branches.add(name)
    }
    for (const r of sourceCodeResults) {
      const branch = (r.metadata?.branch as string) || ''
      if (branch) branches.add(branch)
    }
    return Array.from(branches).sort()
  }, [sourceCodeResults, sourceFacets.branches])

  // Collect distinct Slack metadata values from current results for filter dropdowns
  const slackChannelNames = useMemo(() => {
    const channels = new Set<string>()
    for (const name of slackFacets.channels) {
      if (name) channels.add(name)
    }
    for (const r of slackResults) {
      const channel = (r.metadata?.channel as string) || ''
      if (channel) channels.add(channel)
    }
    return Array.from(channels).sort()
  }, [slackResults, slackFacets.channels])

  const slackWorkspaceNames = useMemo(() => {
    const workspaces = new Set<string>()
    for (const name of slackFacets.workspaces) {
      if (name) workspaces.add(name)
    }
    for (const r of slackResults) {
      const workspace = (r.metadata?.workspace as string) || ''
      if (workspace) workspaces.add(workspace)
    }
    return Array.from(workspaces).sort()
  }, [slackResults, slackFacets.workspaces])

  // Load Slack facets from ingested document metadata so dropdowns populate before searching
  useEffect(() => {
    let cancelled = false
    if (searchCollection !== 'slack') return

    const loadSlackFacets = async () => {
      try {
        const channels = new Set<string>()
        const workspaces = new Set<string>()
        let offset = 0
        const limit = 200

        while (true) {
          const response = await listSlackDocuments({ limit, offset })
          if (cancelled) return
          for (const doc of response.documents || []) {
            const metadata = doc.metadata || {}
            const channel = (metadata.channel as string) || ''
            const workspace = (metadata.workspace as string) || ''
            if (channel) channels.add(channel)
            if (workspace) workspaces.add(workspace)
          }
          if (!response.pagination?.has_more) break
          offset += limit
          if (offset > 5000) break
        }

        if (cancelled) return
        const nextFacets = {
          channels: Array.from(channels).sort(),
          workspaces: Array.from(workspaces).sort(),
        }
        setSlackFacets(nextFacets)

        if (slackChannel && !nextFacets.channels.includes(slackChannel)) {
          setSlackChannel('')
          const params = new URLSearchParams(window.location.search)
          params.delete('channel')
          setLocation(`/search?${params.toString()}`, { replace: true })
        }
        if (slackWorkspace && !nextFacets.workspaces.includes(slackWorkspace)) {
          setSlackWorkspace('')
          const params = new URLSearchParams(window.location.search)
          params.delete('workspace')
          setLocation(`/search?${params.toString()}`, { replace: true })
        }
      } catch {
        if (cancelled) return
        setSlackFacets({ channels: [], workspaces: [] })
      }
    }

    loadSlackFacets()

    return () => {
      cancelled = true
    }
  }, [searchCollection, refreshKey, setLocation, slackChannel, slackWorkspace])

  // Load source-code facets when Source Code tab is active so dropdowns populate
  useEffect(() => {
    let cancelled = false
    if (searchCollection !== 'source') return

    getSourceCodeFacets({ repo: repoFilter || undefined })
      .then((facets) => {
        if (cancelled) return
        const nextFacets = {
          repos: facets.repos || [],
          languages: facets.languages || [],
          branches: facets.branches || [],
        }
        setSourceFacets(nextFacets)

        // If repo narrows available options, clear invalid selections.
        if (sourceLang && !nextFacets.languages.includes(sourceLang)) {
          setSourceLang('')
          const params = new URLSearchParams(window.location.search)
          params.delete('language')
          setLocation(`/search?${params.toString()}`, { replace: true })
        }
        if (sourceBranch && !nextFacets.branches.includes(sourceBranch)) {
          setSourceBranch('')
          const params = new URLSearchParams(window.location.search)
          params.delete('branch')
          setLocation(`/search?${params.toString()}`, { replace: true })
        }
      })
      .catch(() => {
        if (cancelled) return
        setSourceFacets({ repos: [], languages: [], branches: [] })
      })

    return () => {
      cancelled = true
    }
  }, [searchCollection, repoFilter, refreshKey, setLocation, sourceBranch, sourceLang])

  // Load document facets when Docs tab is active so filter dropdowns populate
  useEffect(() => {
    let cancelled = false
    if (searchCollection !== 'docs') return

    getDocsFacets()
      .then((facets) => {
        if (cancelled) return
        setDocFacets({
          projects: facets.projects || [],
          file_types: facets.file_types || [],
          tags: facets.tags || [],
        })
      })
      .catch(() => {
        if (cancelled) return
        setDocFacets({ projects: [], file_types: [], tags: [] })
      })

    return () => {
      cancelled = true
    }
  }, [searchCollection])

  // Load project-specific type options (best-effort)
  // Use first selected project for type filtering
  const selectedProjectIds = filters.project_ids ? filters.project_ids.split(',').filter(Boolean) : []
  const firstProjectId = selectedProjectIds[0] || ''
  useEffect(() => {
    let mounted = true

    if (!firstProjectId) {
      setProjectTypeOptions(null)
      setProjectAllTypeOptions(null)
      setProjectTopLevelTypeOptions(null)
      setProjectTypeHierarchy({})
      getMemoryTypes()
        .then((types) => {
          const topLevel = uniqueTypeList(
            (types || [])
              .filter((entry) => !entry.parent_type)
              .map((entry) => entry.type)
          ) as MemoryType[]
          if (mounted) setGlobalTopLevelTypeOptions(topLevel.length ? topLevel : null)
        })
        .catch(() => {
          if (mounted) setGlobalTopLevelTypeOptions(null)
        })
      return () => {
        mounted = false
      }
    }

    getProjectMemoryTypes(firstProjectId)
      .then((data) => {
        if (!data) {
          if (mounted) setProjectTypeOptions(null)
          if (mounted) setProjectAllTypeOptions(null)
          if (mounted) setProjectTopLevelTypeOptions(null)
          if (mounted) setProjectTypeHierarchy({})
          return
        }
        const memoryTypes = data.memory_types || []
        const allTypes = uniqueTypeList(memoryTypes.map((entry) => entry.type))
        const { hierarchy } = buildTypeHierarchy(memoryTypes)
        const topLevelTypes = uniqueTypeList(
          memoryTypes.filter((entry) => !entry.parent_type).map((entry) => entry.type)
        )
        const available = memoryTypes
          .filter((entry) => {
            const count =
              typeof entry.usage_count === 'number'
                ? entry.usage_count
                : Number(entry.usage_count)
            return Number.isFinite(count) ? count > 0 : false
          })
          .map((entry) => entry.type)

        if (mounted) {
          setProjectTypeOptions(topLevelTypes.length ? topLevelTypes : null)
          setProjectAllTypeOptions(allTypes.length ? allTypes : null)
          setProjectTopLevelTypeOptions(topLevelTypes.length ? topLevelTypes : null)
          setGlobalTopLevelTypeOptions(null)
          setProjectTypeHierarchy(hierarchy)
          if (filters.type && !available.includes(filters.type as MemoryType)) {
            const nextFilters = { ...filters, type: '', subtype: '', status: '' }
            setFilters(nextFilters)
            updateUrl(query, nextFilters)
          }
        }
      })
      .catch(() => {
        if (mounted) setProjectTypeOptions(null)
        if (mounted) setProjectAllTypeOptions(null)
        if (mounted) setProjectTopLevelTypeOptions(null)
        if (mounted) setGlobalTopLevelTypeOptions(null)
        if (mounted) setProjectTypeHierarchy({})
      })

    return () => {
      mounted = false
    }
  }, [firstProjectId, filters.type, updateUrl])

  // Sync URL changes to local state
  useEffect(() => {
    setQuery(urlQuery)
    setSearchMode(urlMode)
    setSearchCollection(urlCollection)
    setIncludeThinking(urlIncludeThinking)
    setRepoFilter(params.get('repo') || '')
    setSlackChannel(params.get('channel') || '')
    setSlackWorkspace(params.get('workspace') || '')
    setSourceLang(params.get('language') || '')
    setSourceBranch(params.get('branch') || '')
    setSourceDisplayMode(urlSourceDisplay)
    setFilters(urlFilters)
    const ids = parseMemoryIdQuery(urlQuery)
    setMemoryIdFilter(ids ?? [])
    if (!ids) setMissingMemoryCount(0)
  }, [searchString, timeZone])

  // Handle query change
  const handleQueryChange = useCallback(
    (newQuery: string) => {
      setQuery(newQuery)
      setMissingMemoryCount(0)
      const ids = parseMemoryIdQuery(newQuery)
      setMemoryIdFilter(ids ?? [])
      updateUrl(newQuery, filters)
    },
    [filters, updateUrl]
  )

  const handleClearAll = useCallback(() => {
    const emptyFilters: FilterValues = {
      project_ids: '', type: '', subtype: '', tag: '', handle: '',
      // handleClearAll also wipes the query, so the non-search default applies.
      status: '', sort: 'created_at', date: '', date_from: '', date_to: '',
      date_range_mode: false, pinned: '',
    }
    setQuery('')
    setFilters(emptyFilters)
    setMemoryIdFilter([])
    setMissingMemoryCount(0)
    setRepoFilter('')
    setSlackChannel('')
    setSlackWorkspace('')
    setSourceLang('')
    setSourceBranch('')
    setDocProject('')
    setDocFileType('')
    setDocTag('')
    setLocation('/search', { replace: true })
  }, [setLocation])

  // Handle filter change
  const handleFiltersChange = useCallback(
    (newFilters: FilterValues) => {
      setFilters(newFilters)
      updateUrl(query, newFilters)
    },
    [query, updateUrl]
  )

  // Handle search mode change
  const handleModeChange = useCallback(
    (mode: SearchMode) => {
      setSearchMode(mode)
      updateUrl(query, filters, mode, searchCollection)
    },
    [query, filters, searchCollection, updateUrl]
  )

  // Handle collection change
  const handleCollectionChange = useCallback(
    (collection: SearchCollection) => {
      setSearchCollection(collection)
      setMemories([])
      setSessionResults([])
      setKeywordSessionResults([])
      setCommitResults([])
      setSlackResults([])
      setSourceCodeResults([])
      setDocResults([])
      setPagination(null)
      // Force semantic mode for collections that only support it
      const effectiveMode = SEMANTIC_ONLY_COLLECTIONS.includes(collection) ? 'semantic' : searchMode
      if (effectiveMode !== searchMode) setSearchMode(effectiveMode)
      updateUrl(query, filters, effectiveMode, collection)
    },
    [query, filters, searchMode, updateUrl]
  )

  // Handle commit repo filter change
  const handleRepoFilterChange = useCallback(
    (repo: string) => {
      setRepoFilter(repo)
      updateUrl(query, filters, searchMode, searchCollection, includeThinking, repo, slackChannel, slackWorkspace, sourceLang, sourceBranch)
    },
    [query, filters, searchMode, searchCollection, includeThinking, slackChannel, slackWorkspace, sourceLang, sourceBranch, updateUrl]
  )

  const handleSlackChannelChange = useCallback(
    (channel: string) => {
      setSlackChannel(channel)
      const params = new URLSearchParams(window.location.search)
      if (channel) params.set('channel', channel); else params.delete('channel')
      setLocation(`/search?${params.toString()}`, { replace: true })
    },
    [setLocation]
  )

  const handleSlackWorkspaceChange = useCallback(
    (workspace: string) => {
      setSlackWorkspace(workspace)
      const params = new URLSearchParams(window.location.search)
      if (workspace) params.set('workspace', workspace); else params.delete('workspace')
      setLocation(`/search?${params.toString()}`, { replace: true })
    },
    [setLocation]
  )

  // Handle source code filter changes — read current URL directly to avoid stale closures
  const handleSourceLangChange = useCallback(
    (lang: string) => {
      setSourceLang(lang)
      const params = new URLSearchParams(window.location.search)
      if (lang) params.set('language', lang); else params.delete('language')
      setLocation(`/search?${params.toString()}`, { replace: true })
    },
    [setLocation]
  )

  const handleSourceBranchChange = useCallback(
    (branch: string) => {
      setSourceBranch(branch)
      const params = new URLSearchParams(window.location.search)
      if (branch) params.set('branch', branch); else params.delete('branch')
      setLocation(`/search?${params.toString()}`, { replace: true })
    },
    [setLocation]
  )

  // Handle include thinking toggle
  const handleIncludeThinkingChange = useCallback(
    (include: boolean) => {
      setIncludeThinking(include)
      updateUrl(query, filters, searchMode, searchCollection, include)
    },
    [query, filters, searchMode, searchCollection, updateUrl]
  )

  const buildEditorDeepLinkForResult = useCallback(
    (result: SourceCodeSearchResult) => {
      const repo = (result.metadata?.repoName as string) || (result.metadata?.repo as string) || ''
      const root = repo ? repoRootMap[repo] : ''
      const line = extractResultLine(result.metadata)
      const col = extractResultColumn(result.metadata)
      const needle = buildSnippetNeedle(result.content)
      setEditorDeepLink({
        path: result.file_path,
        root: root || undefined,
        line: line || undefined,
        col: col || undefined,
        needle: needle || undefined,
      })
    },
    [repoRootMap]
  )

  const handleSourceResultClick = useCallback(
    (result: SourceCodeSearchResult) => {
      buildEditorDeepLinkForResult(result)
      setLocation('/editor')
    },
    [buildEditorDeepLinkForResult, setLocation]
  )

  const handleSourceResultOpenInEditor = useCallback(
    (result: SourceCodeSearchResult) => {
      buildEditorDeepLinkForResult(result)
      setLocation('/editor')
    },
    [buildEditorDeepLinkForResult, setLocation]
  )

  const handleSourceResultOpenInNewTab = useCallback(
    (result: SourceCodeSearchResult) => {
      buildEditorDeepLinkForResult(result)
      const opened = window.open('/editor', '_blank')
      if (!opened) showToast('Popup blocked: allow popups to open in a new tab')
    },
    [buildEditorDeepLinkForResult, showToast]
  )

  // Context menu handlers
  const handleContextMenu = useCallback((e: MouseEvent, memory: Memory) => {
    e.preventDefault()
    setContextMenu({ memory, x: e.clientX, y: e.clientY })
  }, [])

  const handleDeleteMemory = useCallback(async () => {
    if (!deleteTarget) return

    setIsDeletingMemory(true)
    try {
      await deleteMemory(deleteTarget.project_id, deleteTarget.id)
      setDeleteTarget(null)
      setRefreshKey((k) => k + 1)
    } catch (err: any) {
      console.error('Failed to delete memory:', err.message)
    } finally {
      setIsDeletingMemory(false)
    }
  }, [deleteTarget])

  // Fetch results when URL params change
  useEffect(() => {
    let cancelled = false

    const clearAllResults = () => {
      setMemories([])
      setSessionResults([])
      setKeywordSessionResults([])
      setCommitResults([])
      setSlackResults([])
      setSourceCodeResults([])
      setDocResults([])
      setPagination(null)
    }

    const loadByIds = async () => {
      const ids = Array.from(new Set(memoryIdFilter))
      try {
        const responses = await Promise.all(
          ids.map(async (id) => {
            try {
              return await getMemory(id)
            } catch {
              return null
            }
          })
        )
        if (cancelled) return
        const found = responses.filter((m): m is Memory => m !== null)
        clearAllResults()
        setMemories(found)
        setPagination({ total_count: found.length, limit: found.length, offset: 0, has_more: false })
        setMissingMemoryCount(ids.length - found.length)
      } catch (err: any) {
        if (cancelled) return
        setError(err.message || 'Failed to load memories')
        clearAllResults()
      }
    }

    const loadBySearch = async () => {
      // Session search
      if (urlCollection === 'sessions' && urlQuery) {
        if (urlMode === 'keyword') {
          // Keyword search via PostgreSQL
          try {
            const response = await searchSessionsKeyword({
              q: urlQuery,
              project: urlFilters.project_ids || undefined,
              limit: 20,
            })
            if (cancelled) return
            clearAllResults()
            setKeywordSessionResults(response.results)
          } catch (err: any) {
            if (cancelled) return
            setError(err.message || 'Session keyword search failed')
            setKeywordSessionResults([])
          }
        } else {
          // Semantic search via ChromaDB
          try {
            const response = await searchSessions('claude-code', {
              q: urlQuery,
              mode: urlMode,
              projectDir: urlFilters.project_ids || undefined,
              limit: 20,
              includeThinking: urlIncludeThinking,
            })
            if (cancelled) return
            clearAllResults()
            setSessionResults(response.results)
          } catch (err: any) {
            if (cancelled) return
            setError(err.message || 'Session search failed')
            setSessionResults([])
            setKeywordSessionResults([])
          }
        }
        return
      }

      // Commit search (semantic only)
      if (urlCollection === 'commits' && urlQuery) {
        const urlRepo = new URLSearchParams(searchString).get('repo') || ''
        try {
          const response = await searchCommits({
            q: urlQuery,
            repo: urlRepo || undefined,
            limit: 20,
          })
          if (cancelled) return
          clearAllResults()
          setCommitResults(response.results)
          setPagination(response.pagination)
        } catch (err: any) {
          if (cancelled) return
          setError(err.message || 'Commit search failed')
          setCommitResults([])
        }
        return
      }

      // Slack search (semantic + keyword)
      if (urlCollection === 'slack' && urlQuery) {
        const slackParams = new URLSearchParams(searchString)
        const urlChannel = slackParams.get('channel') || ''
        const urlWorkspace = slackParams.get('workspace') || ''
        try {
          const response = await searchSlack({
            q: urlQuery,
            mode: urlMode,
            channel: urlChannel || undefined,
            workspace: urlWorkspace || undefined,
            limit: 20,
          })
          if (cancelled) return
          clearAllResults()
          setSlackResults(response.results)
        } catch (err: any) {
          if (cancelled) return
          setError(err.message || 'Slack search failed')
          setSlackResults([])
        }
        return
      }

      // Source code search (semantic only)
      if (urlCollection === 'source' && urlQuery) {
        const sourceParams = new URLSearchParams(searchString)
        const urlRepo = sourceParams.get('repo') || ''
        const urlLang = sourceParams.get('language') || ''
        const urlBranch = sourceParams.get('branch') || ''
        try {
          const response = await searchSourceCode({
            q: urlQuery,
            repo: urlRepo || undefined,
            language: urlLang || undefined,
            branch: urlBranch || undefined,
            limit: 20,
          })
          if (cancelled) return
          clearAllResults()
          setSourceCodeResults(response.results)
        } catch (err: any) {
          if (cancelled) return
          setError(err.message || 'Source code search failed')
          setSourceCodeResults([])
        }
        return
      }

      // Document search (semantic only)
      if (urlCollection === 'docs' && urlQuery) {
        const docParams = new URLSearchParams(searchString)
        const urlDocProject = docParams.get('doc_project') || ''
        const urlDocFileType = docParams.get('doc_file_type') || ''
        const urlDocTag = docParams.get('doc_tag') || ''
        try {
          const response = await searchDocs({
            q: urlQuery,
            project: urlDocProject || undefined,
            file_type: urlDocFileType || undefined,
            tag: urlDocTag || undefined,
            limit: 20,
          })
          if (cancelled) return
          clearAllResults()
          setDocResults(response.results)
        } catch (err: any) {
          if (cancelled) return
          setError(err.message || 'Document search failed')
          setDocResults([])
        }
        return
      }

      // Memory semantic search
      if (urlMode === 'semantic' && urlQuery) {
        try {
          const response = await vectorSearch({
            q: urlQuery,
            project_id: urlFilters.project_ids || undefined,
            type: ((urlFilters.subtype || urlFilters.type) as MemoryType) || undefined,
            limit: 20,
            compact: true,
          })
          if (cancelled) return
          clearAllResults()
          setMemories(response.memories)
          setPagination(response.pagination)
        } catch (err: any) {
          if (cancelled) return
          setError(err.message || 'Semantic search failed')
          setMemories([])
          setPagination(null)
        }
        return
      }

      // Keyword search with full filter support
      const dateFilters = urlFilters.date_range_mode
        ? {
            created_after: urlFilters.date_from || undefined,
            created_before: urlFilters.date_to || undefined,
          }
        : urlFilters.date
          ? { created_after: urlFilters.date, created_before: urlFilters.date }
          : { created_after: undefined, created_before: undefined }

      try {
        const response = await searchMemories({
          q: urlQuery || undefined,
          project_id: urlFilters.project_ids || undefined,
          type: ((urlFilters.subtype || urlFilters.type) as MemoryType) || undefined,
          tag: urlFilters.tag || undefined,
          handle: urlFilters.handle || undefined,
          status: (urlFilters.type || urlFilters.subtype) ? urlFilters.status || undefined : undefined,
          sort: urlFilters.sort as 'relevance' | 'updated_at' | 'created_at' | 'title',
          compact: true,
          limit: 20,
          offset: 0,
          created_after: dateFilters.created_after,
          created_before: dateFilters.created_before,
          tz: timeZone,
          pinned: urlFilters.pinned === 'true' ? true : undefined,
        })
        if (cancelled) return
        clearAllResults()
        setMemories(response.memories)
        setPagination(response.pagination)
      } catch (err: any) {
        if (cancelled) return
        setError(err.message || 'Failed to search memories')
        clearAllResults()
      }
    }

    const hasFilters =
      urlQuery || urlFilters.project_ids || urlFilters.type || urlFilters.subtype || urlFilters.tag || urlFilters.handle ||
      urlFilters.status || urlFilters.pinned || urlFilters.date || urlFilters.date_from || urlFilters.date_to

    if (!hasFilters && memoryIdFilter.length === 0) {
      clearAllResults()
      return
    }

    setIsLoading(true)
    setError(null)

    const load = async () => {
      if (memoryIdFilter.length > 0) {
        await loadByIds()
      } else {
        await loadBySearch()
      }
      if (!cancelled) setIsLoading(false)
    }

    load()

    return () => {
      cancelled = true
    }
  }, [searchString, memoryIdFilter, refreshKey])

  const hasQuery = !!(
    urlQuery || urlFilters.project_ids || urlFilters.type || urlFilters.subtype || urlFilters.tag || urlFilters.handle ||
    urlFilters.status || urlFilters.pinned || urlFilters.date || urlFilters.date_from || urlFilters.date_to
  )
  const isMemoryIdQuery = memoryIdFilter.length > 0

  return (
    <div class={styles.page}>
      <div class={styles.header}>
        <div class={styles.titleRow}>
          <h1 class={styles.title}>Search</h1>
          {hasQuery && (
            <button type="button" class={styles.clearAllButton} onClick={handleClearAll} title="Clear search and filters">
              <RotateCcw size={14} />
              Clear
            </button>
          )}
        </div>
        <div class={styles.searchSection}>
          <SearchBar
            value={query}
            onChange={handleQueryChange}
            placeholder="Press Enter to search"
            submitOnEnter
          />
          {vectorEnabled && (
            <div class={styles.modeToggle}>
              <span class={styles.modeLabel}>Mode</span>
              <button
                type="button"
                class={searchMode === 'keyword' ? styles.modeButtonActive : styles.modeButton}
                disabled={SEMANTIC_ONLY_COLLECTIONS.includes(searchCollection)}
                onClick={() => handleModeChange('keyword')}
              >
                Keyword
              </button>
              <button
                type="button"
                class={searchMode === 'semantic' ? styles.modeButtonActive : styles.modeButton}
                onClick={() => handleModeChange('semantic')}
              >
                Semantic
              </button>
              <span class={styles.modeSeparator}>|</span>
              <span class={styles.modeLabel}>Collection</span>
              <button
                type="button"
                class={searchCollection === 'memories' ? styles.modeButtonActive : styles.modeButton}
                onClick={() => handleCollectionChange('memories')}
              >
                Memories
              </button>
              <button
                type="button"
                class={searchCollection === 'sessions' ? styles.modeButtonActive : styles.modeButton}
                onClick={() => handleCollectionChange('sessions')}
              >
                Sessions
              </button>
              <button
                type="button"
                class={searchCollection === 'commits' ? styles.modeButtonActive : styles.modeButton}
                onClick={() => handleCollectionChange('commits')}
              >
                Commits
              </button>
              <button
                type="button"
                class={searchCollection === 'slack' ? styles.modeButtonActive : styles.modeButton}
                onClick={() => handleCollectionChange('slack')}
              >
                Slack
              </button>
              <button
                type="button"
                class={searchCollection === 'source' ? styles.modeButtonActive : styles.modeButton}
                onClick={() => handleCollectionChange('source')}
              >
                Source Code
              </button>
              <button
                type="button"
                class={searchCollection === 'docs' ? styles.modeButtonActive : styles.modeButton}
                onClick={() => handleCollectionChange('docs')}
              >
                Docs
              </button>
            </div>
          )}
          {searchCollection === 'commits' && commitRepoNames.length > 1 && (
            <div class={styles.repoFilter}>
              <label class={styles.repoLabel} for="commit-repo-filter">Repo</label>
              <select
                id="commit-repo-filter"
                class={styles.repoSelect}
                value={repoFilter}
                onChange={(e) => handleRepoFilterChange((e.target as HTMLSelectElement).value)}
              >
                <option value="">All repos</option>
                {commitRepoNames.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>
          )}
          {searchCollection === 'sessions' && (
            <label class={styles.thinkingToggle}>
              <input
                type="checkbox"
                checked={includeThinking}
                onChange={(e) => handleIncludeThinkingChange((e.target as HTMLInputElement).checked)}
              />
              Include thinking blocks
            </label>
          )}
          {searchCollection === 'slack' && (
            <div class={styles.sourceFilters}>
              <div class={styles.sourceFilterGroup}>
                <label class={styles.sourceFilterLabel}>Channel</label>
                <select
                  class={styles.sourceFilterSelect}
                  value={slackChannel}
                  onChange={(e) => handleSlackChannelChange((e.target as HTMLSelectElement).value)}
                >
                  <option value="">All channels</option>
                  {slackChannelNames.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>
              <div class={styles.sourceFilterGroup}>
                <label class={styles.sourceFilterLabel}>Workspace</label>
                <select
                  class={styles.sourceFilterSelect}
                  value={slackWorkspace}
                  onChange={(e) => handleSlackWorkspaceChange((e.target as HTMLSelectElement).value)}
                >
                  <option value="">All workspaces</option>
                  {slackWorkspaceNames.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
          {searchCollection === 'source' && (
            <div class={styles.sourceFilters}>
              <div class={styles.sourceFilterGroup}>
                <label class={styles.sourceFilterLabel}>Repo</label>
                <select
                  class={styles.sourceFilterSelect}
                  value={repoFilter}
                  onChange={(e) => {
                    const repo = (e.target as HTMLSelectElement).value
                    setRepoFilter(repo)
                    const params = new URLSearchParams(window.location.search)
                    if (repo) params.set('repo', repo); else params.delete('repo')
                    setLocation(`/search?${params.toString()}`, { replace: true })
                  }}
                >
                  <option value="">All repos</option>
                  {sourceRepoNames.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>
              <div class={styles.sourceFilterGroup}>
                <label class={styles.sourceFilterLabel}>Language</label>
                <select
                  class={styles.sourceFilterSelect}
                  value={sourceLang}
                  onChange={(e) => handleSourceLangChange((e.target as HTMLSelectElement).value)}
                >
                  <option value="">All languages</option>
                  {sourceLangNames.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>
              <div class={styles.sourceFilterGroup}>
                <label class={styles.sourceFilterLabel}>Branch</label>
                <select
                  class={styles.sourceFilterSelect}
                  value={sourceBranch}
                  onChange={(e) => handleSourceBranchChange((e.target as HTMLSelectElement).value)}
                >
                  <option value="">All branches</option>
                  {sourceBranchNames.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>
              <div class={styles.sourceFilterGroup}>
                <label class={styles.sourceFilterLabel}>Display</label>
                <select
                  class={styles.sourceFilterSelect}
                  value={sourceDisplayMode}
                  onChange={(e) => {
                    const mode = (e.target as HTMLSelectElement).value as SourceDisplayMode
                    setSourceDisplayMode(mode)
                    const params = new URLSearchParams(window.location.search)
                    if (mode === 'grouped') params.delete('sourceDisplay')
                    else params.set('sourceDisplay', mode)
                    setLocation(`/search?${params.toString()}`, { replace: true })
                  }}
                >
                  <option value="grouped">Grouped</option>
                  <option value="all">All chunks</option>
                </select>
              </div>
              {sourceDisplayMode === 'grouped' && (
                <div class={styles.sourceFilterGroup}>
                  <label class={styles.sourceFilterLabel}>Initial chunks per file</label>
                  <select
                    class={styles.sourceFilterSelect}
                    value={String(sourcePerFile)}
                    onChange={(e) => {
                      const count = Number((e.target as HTMLSelectElement).value) as SourcePerFileCount
                      setSourcePerFile(count)
                    }}
                  >
                    <option value="1">1</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                    <option value="5">5</option>
                  </select>
                </div>
              )}
            </div>
          )}
          {searchCollection === 'docs' && (
            <div class={styles.sourceFilters}>
              <div class={styles.sourceFilterGroup}>
                <label class={styles.sourceFilterLabel}>Project</label>
                <select
                  class={styles.sourceFilterSelect}
                  value={docProject}
                  onChange={(e) => {
                    const val = (e.target as HTMLSelectElement).value
                    setDocProject(val)
                    const p = new URLSearchParams(window.location.search)
                    if (val) p.set('doc_project', val); else p.delete('doc_project')
                    setLocation(`/search?${p.toString()}`, { replace: true })
                  }}
                >
                  <option value="">All projects</option>
                  {docFacets.projects.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>
              <div class={styles.sourceFilterGroup}>
                <label class={styles.sourceFilterLabel}>Type</label>
                <select
                  class={styles.sourceFilterSelect}
                  value={docFileType}
                  onChange={(e) => {
                    const val = (e.target as HTMLSelectElement).value
                    setDocFileType(val)
                    const p = new URLSearchParams(window.location.search)
                    if (val) p.set('doc_file_type', val); else p.delete('doc_file_type')
                    setLocation(`/search?${p.toString()}`, { replace: true })
                  }}
                >
                  <option value="">All types</option>
                  {docFacets.file_types.map((name) => (
                    <option key={name} value={name}>.{name}</option>
                  ))}
                </select>
              </div>
              <div class={styles.sourceFilterGroup}>
                <label class={styles.sourceFilterLabel}>Tag</label>
                <select
                  class={styles.sourceFilterSelect}
                  value={docTag}
                  onChange={(e) => {
                    const val = (e.target as HTMLSelectElement).value
                    setDocTag(val)
                    const p = new URLSearchParams(window.location.search)
                    if (val) p.set('doc_tag', val); else p.delete('doc_tag')
                    setLocation(`/search?${p.toString()}`, { replace: true })
                  }}
                >
                  <option value="">All tags</option>
                  {docFacets.tags.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
          <FiltersPanel
            filters={filters}
            onChange={handleFiltersChange}
            projects={projects}
            typeOptions={projectTypeOptions || globalTopLevelTypeOptions}
            typeHierarchy={projectTypeHierarchy}
          />
      </div>

      <div class={styles.divider} />

      {error && <div class={styles.error}>{error}</div>}

      {isMemoryIdQuery && (
        <div class={styles.searchHint}>
          Filtering by {memoryIdFilter.length} memory ID{memoryIdFilter.length !== 1 ? 's' : ''}.
          {missingMemoryCount > 0 && (
            <span class={styles.searchHintWarning}>
              {' '}({missingMemoryCount} not found)
            </span>
          )}
        </div>
      )}

      {searchMode === 'semantic' && !isMemoryIdQuery && searchCollection === 'memories' && (
        <div class={styles.searchHint}>
          Using semantic search. Only query, project, and type filters are supported. Press Enter to search.
        </div>
      )}

      {!isMemoryIdQuery && searchCollection === 'sessions' && (
        <div class={styles.searchHint}>
          Searching session transcripts ({searchMode} mode). Press Enter to search.
        </div>
      )}

      {!isMemoryIdQuery && searchCollection === 'commits' && (
        <div class={styles.searchHint}>
          Searching indexed commit messages (semantic). Press Enter to search.
        </div>
      )}

      {!isMemoryIdQuery && searchCollection === 'slack' && (
        <div class={styles.searchHint}>
          Searching ingested Slack messages (semantic). Press Enter to search.
        </div>
      )}

      {!isMemoryIdQuery && searchCollection === 'source' && (
        <div class={styles.searchHint}>
          Searching indexed source code (semantic). Press Enter to search.
        </div>
      )}

      {!isMemoryIdQuery && searchCollection === 'docs' && (
        <div class={styles.searchHint}>
          Searching indexed documents (semantic). Press Enter to search.
        </div>
      )}

      {searchCollection === 'sessions' ? (
        searchMode === 'keyword' ? (
          <KeywordSessionResultsList
            results={keywordSessionResults}
            isLoading={isLoading}
            hasQuery={!!urlQuery}
          />
        ) : (
          <SessionResultsList
            results={sessionResults}
            isLoading={isLoading}
            hasQuery={!!urlQuery}
          />
        )
      ) : searchCollection === 'commits' ? (
        <CommitResultsList
          results={commitResults}
          isLoading={isLoading}
          hasQuery={!!urlQuery}
          repoProjectMap={repoProjectMap}
        />
      ) : searchCollection === 'slack' ? (
        <SlackResultsList
          results={slackResults}
          isLoading={isLoading}
          hasQuery={!!urlQuery}
        />
      ) : searchCollection === 'source' ? (
        <SourceCodeResultsList
          results={sourceCodeResults}
          isLoading={isLoading}
          hasQuery={!!urlQuery}
          groupByFile={sourceDisplayMode === 'grouped'}
          maxPerFile={sourcePerFile}
          onResultClick={handleSourceResultClick}
          onOpenInEditor={handleSourceResultOpenInEditor}
          onOpenInNewTab={handleSourceResultOpenInNewTab}
        />
      ) : searchCollection === 'docs' ? (
        <DocResultsList
          results={docResults}
          isLoading={isLoading}
          hasQuery={!!urlQuery}
          onOpenInEditor={(result) => {
            setEditorDeepLink({ path: result.file_path })
            window.open('/editor', '_blank')
          }}
        />
      ) : (
        <ResultsList
          memories={memories}
          pagination={pagination}
          isLoading={isLoading}
          hasQuery={hasQuery}
          onContextMenu={handleContextMenu}
        />
      )}

      {contextMenu && (
        <MemoryContextMenu
          memory={contextMenu.memory}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          typeOptions={projectTopLevelTypeOptions || globalTopLevelTypeOptions || projectAllTypeOptions || projectTypeOptions || undefined}
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
    </div>
  )
}
