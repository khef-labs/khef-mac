import { useState, useMemo, useEffect, useCallback, useRef } from 'preact/hooks'
import { Link } from 'wouter-preact'
import { RefreshCw, BarChart3, Brain, Cpu, Zap, AlertTriangle, Unlink, Network, HelpCircle, LayoutGrid, List, ChevronRight, Copy } from 'lucide-preact'
import { useToast } from '../components/ui'
import { useFetch, useDocumentTitle } from '../hooks'
import { getStatsOverview, getStatsMemory, getStatsUsage, getStatsSystem, getProjects } from '../lib/api'
import { TabBar, SortBar } from '../components/ui'
import type { Tab, SortState } from '../components/ui'
import type { Project } from '../types/api'
import styles from './StatsPage.module.css'

type TabKey = 'overview' | 'memory' | 'usage' | 'system'
type TimeRange = '7d' | '30d' | '90d' | 'all'

const TYPE_COLORS: Record<string, string> = {
  decision: 'var(--node-decision)',
  pattern: 'var(--node-pattern)',
  context: 'var(--node-context)',
  'assistant-todo': 'var(--node-todo)',
  'user-todo': 'var(--node-todo)',
  'user-note': 'var(--node-note)',
  'assistant-note': 'var(--node-note)',
  'project-note': 'var(--node-note)',
  commands: 'var(--node-command)',
  api: 'var(--node-api)',
  reference: 'var(--node-reference)',
  'assistant-rule': 'var(--node-rule)',
  csv: 'var(--node-csv)',
  video: 'var(--node-video)',
  canvas: 'var(--node-canvas)',
  widget: 'var(--node-canvas)',
  animation: 'var(--node-canvas)',
  prototype: 'var(--node-canvas)',
  quiz: 'var(--node-canvas)',
  diagram: '#a78bfa',
  knowledge: 'var(--node-context)',
}

const TABS: Tab[] = [
  { key: 'overview', label: 'Overview', icon: BarChart3 },
  { key: 'memory', label: 'Memory Analysis', icon: Brain },
  { key: 'usage', label: 'Claude Usage', icon: Zap },
  { key: 'system', label: 'System', icon: Cpu },
]

const TIME_RANGES: { key: TimeRange; label: string }[] = [
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: 'all', label: 'All' },
]

function formatLabel(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

const STATUS_COLORS: Record<string, string> = {
  open: 'var(--warning)',
  in_progress: 'var(--brand-blue)',
  blocked: 'var(--error)',
  done: 'var(--muted)',
  canceled: 'var(--border)',
  proposed: 'var(--warning)',
  accepted: 'var(--brand-green)',
  rejected: 'var(--error)',
  superseded: 'var(--muted)',
  active: 'var(--brand-green)',
  deprecated: 'var(--muted)',
  current: 'var(--brand-green)',
  outdated: 'var(--warning)',
  updated: 'var(--brand-blue)',
  inactive: 'var(--border)',
  unverified: 'var(--warning)',
  verified: 'var(--brand-green)',
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) {
    const b = n / 1_000_000_000
    return b === Math.floor(b) ? `${b}B` : `${b.toFixed(1)}B`
  }
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return m === Math.floor(m) ? `${m}M` : `${m.toFixed(1)}M`
  }
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatCost(n: number): string {
  if (n >= 1000) return `$${n.toFixed(0)}`
  if (n >= 10) return `$${n.toFixed(1)}`
  return `$${n.toFixed(2)}`
}

function formatModelName(model: string): string {
  if (model === 'unknown') return 'Unknown'
  return model
    .replace('claude-', '')
    .replace(/-\d{8}$/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

const MODEL_COLORS: Record<string, string> = {
  'opus': 'var(--brand-purple)',
  'sonnet': 'var(--brand-blue)',
  'haiku': 'var(--brand-green)',
}

function getModelColor(model: string): string {
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (model.toLowerCase().includes(key)) return color
  }
  return 'var(--muted)'
}

function getContextWindowSize(model: string | null): number | null {
  if (!model) return null
  if (model.startsWith('claude-opus-4')) return 1_000_000
  if (model.startsWith('claude-sonnet-4')) return 200_000
  if (model.startsWith('claude-haiku-4')) return 200_000
  if (model.startsWith('claude-3')) return 200_000
  if (model.includes('gpt-4o') || model.includes('gpt-4')) return 128_000
  if (model.includes('o3') || model.includes('o4')) return 200_000
  return null
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function ActivityHeatmap({ dailyCounts }: { dailyCounts: { date: string; count: number }[] }) {
  const countMap = new Map(dailyCounts.map((d) => [d.date, d.count]))
  const maxCount = Math.max(...dailyCounts.map((d) => d.count), 1)

  // Build 38 weeks of data ending today
  const today = new Date()
  const weeks: { date: Date; dateStr: string; count: number }[][] = []
  const startDate = new Date(today)
  startDate.setDate(startDate.getDate() - (38 * 7 - 1) - startDate.getDay())

  let currentWeek: { date: Date; dateStr: string; count: number }[] = []
  const d = new Date(startDate)
  while (d <= today) {
    const dateStr = d.toISOString().slice(0, 10)
    currentWeek.push({ date: new Date(d), dateStr, count: countMap.get(dateStr) || 0 })
    if (currentWeek.length === 7) {
      weeks.push(currentWeek)
      currentWeek = []
    }
    d.setDate(d.getDate() + 1)
  }
  if (currentWeek.length > 0) weeks.push(currentWeek)

  // Month labels
  const monthLabels: { label: string; col: number }[] = []
  let lastMonth = -1
  weeks.forEach((week, wi) => {
    const firstDay = week[0]
    const month = firstDay.date.getMonth()
    if (month !== lastMonth) {
      monthLabels.push({ label: MONTHS[month], col: wi })
      lastMonth = month
    }
  })

  const getLevel = (count: number): number => {
    if (count === 0) return 0
    if (count <= maxCount * 0.25) return 1
    if (count <= maxCount * 0.5) return 2
    if (count <= maxCount * 0.75) return 3
    return 4
  }

  return (
    <div class={styles.section}>
      <h2 class={styles.sectionTitle}>Activity</h2>
      <div class={styles.heatmapContainer}>
        <div class={styles.heatmapDayLabels}>
          {DAYS.filter((_, i) => i % 2 === 1).map((day) => (
            <span key={day} class={styles.heatmapDayLabel}>{day}</span>
          ))}
        </div>
        <div class={styles.heatmapGrid}>
          <div class={styles.heatmapMonths}>
            {monthLabels.map((m) => (
              <span key={`${m.label}-${m.col}`} class={styles.heatmapMonthLabel} style={{ gridColumn: m.col + 1 }}>{m.label}</span>
            ))}
          </div>
          <div class={styles.heatmapWeeks}>
            {weeks.map((week, wi) => (
              <div key={wi} class={styles.heatmapWeekCol}>
                {week.map((day) => (
                  <div
                    key={day.dateStr}
                    class={styles.heatmapCell}
                    data-level={getLevel(day.count)}
                    title={`${day.dateStr}: ${day.count} memories`}
                  />
                ))}
              </div>
            ))}
          </div>
          <div class={styles.heatmapLegend}>
            <span class={styles.heatmapLegendLabel}>Less</span>
            {[0, 1, 2, 3, 4].map((level) => (
              <div key={level} class={styles.heatmapCell} data-level={level} />
            ))}
            <span class={styles.heatmapLegendLabel}>More</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function StatusBreakdownCard({ type, total, statuses }: { type: string; total: number; statuses: { status: string; count: number }[] }) {
  const color = TYPE_COLORS[type] || 'var(--muted)'
  return (
    <div class={styles.statusCard}>
      <div class={styles.statusCardHeader}>
        <span class={styles.statusDot} style={{ backgroundColor: color }} />
        <span class={styles.statusType}>{formatLabel(type)}</span>
        <span class={styles.statusTotal}>{total}</span>
      </div>
      <div class={styles.statusBar}>
        {statuses.map((s) => {
          const pct = (s.count / total) * 100
          const sColor = STATUS_COLORS[s.status] || 'var(--muted)'
          return (
            <div
              key={s.status}
              class={styles.statusSegment}
              style={{ width: `${pct}%`, backgroundColor: sColor }}
              title={`${formatLabel(s.status)}: ${s.count}`}
            />
          )
        })}
      </div>
      <div class={styles.statusLegend}>
        {statuses.map((s) => {
          const sColor = STATUS_COLORS[s.status] || 'var(--muted)'
          return (
            <span key={s.status} class={styles.statusLegendItem}>
              <span class={styles.statusLegendDot} style={{ backgroundColor: sColor }} />
              {formatLabel(s.status)} ({s.count})
            </span>
          )
        })}
      </div>
    </div>
  )
}

export function StatsPage() {
  useDocumentTitle('Stats')
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    const saved = sessionStorage.getItem('stats-tab')
    return (saved && ['overview', 'memory', 'usage', 'system'].includes(saved)) ? saved as TabKey : 'overview'
  })
  const [timeRange, setTimeRange] = useState<TimeRange>('all')
  const [selectedProject, setSelectedProject] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const statsFilters = useMemo(() => {
    const filters: { project?: string; since?: string; until?: string } = {}
    if (selectedProject) filters.project = selectedProject
    if (timeRange !== 'all') {
      const days = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 90
      const since = new Date()
      since.setDate(since.getDate() - days)
      filters.since = since.toISOString()
    }
    return filters
  }, [selectedProject, timeRange])

  // Track which tabs have been opened at least once. Each tab's fetch stays
  // enabled after first activation so filter changes invalidate its cache and
  // auto-refresh it when visible.
  const [openedTabs, setOpenedTabs] = useState<Set<TabKey>>(() => new Set<TabKey>(['overview']))
  useEffect(() => {
    if (!openedTabs.has(activeTab)) {
      setOpenedTabs((prev) => {
        if (prev.has(activeTab)) return prev
        const next = new Set(prev)
        next.add(activeTab)
        return next
      })
    }
  }, [activeTab, openedTabs])

  const filterSuffix = `${selectedProject || 'all'}-${timeRange}`

  const fetchOverview = useCallback(() => getStatsOverview(statsFilters), [statsFilters])
  const overviewQuery = useFetch(
    `stats-overview-${filterSuffix}`,
    fetchOverview,
    { staleTime: 60000 }
  )

  const fetchMemory = useCallback(() => getStatsMemory(statsFilters), [statsFilters])
  const memoryQuery = useFetch(
    `stats-memory-${filterSuffix}`,
    fetchMemory,
    { staleTime: 60000, enabled: openedTabs.has('memory') }
  )

  const fetchUsage = useCallback(() => getStatsUsage(statsFilters), [statsFilters])
  const usageQuery = useFetch(
    `stats-usage-${filterSuffix}`,
    fetchUsage,
    { staleTime: 60000, enabled: openedTabs.has('usage') }
  )

  const systemQuery = useFetch(
    'stats-system',
    getStatsSystem,
    { staleTime: 30000, enabled: openedTabs.has('system') }
  )

  const data = overviewQuery.data
  const isLoading = overviewQuery.isLoading
  const error = overviewQuery.error
  const memory_analysis = memoryQuery.data
  const claude_usage = usageQuery.data
  const processes = systemQuery.data?.processes
  const system_processes = systemQuery.data?.system_processes
  const [typeView, setTypeView] = useState<'treemap' | 'bars'>('treemap')
  const [projectView, setProjectView] = useState<'treemap' | 'bars'>('treemap')
  const [processSort, setProcessSort] = useState<SortState>({ field: 'rss', direction: 'desc' })
  const [systemSort, setSystemSort] = useState<SortState>({ field: 'rss', direction: 'desc' })
  const [systemSubTab, setSystemSubTab] = useState<'khef' | 'system'>('system')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [expandedSystemGroups, setExpandedSystemGroups] = useState<Set<string>>(new Set())
  const [autoRefresh, setAutoRefresh] = useState<number>(0)
  const [contextMenu, setContextMenu] = useState<{ pid: number; name?: string; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const { showToast } = useToast()

  useEffect(() => {
    if (!contextMenu) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setContextMenu(null)
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    const handleScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return
      setContextMenu(null)
    }
    const timer = setTimeout(() => document.addEventListener('click', handleClick), 0)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', handleClick)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [contextMenu])

  const handleInstanceContextMenu = useCallback((e: MouseEvent, pid: number, name?: string) => {
    e.preventDefault()
    const menuWidth = 180, menuHeight = 48, pad = 8
    let x = e.clientX, y = e.clientY
    if (x + menuWidth + pad > window.innerWidth) x = window.innerWidth - menuWidth - pad
    if (y + menuHeight + pad > window.innerHeight) y = window.innerHeight - menuHeight - pad
    if (x < pad) x = pad
    if (y < pad) y = pad
    setContextMenu({ pid, name, x, y })
  }, [])

  const copyPid = useCallback(async (pid: number) => {
    try { await navigator.clipboard.writeText(String(pid)) } catch { /* ignore */ }
    showToast(`Copied PID ${pid}`)
    setContextMenu(null)
  }, [showToast])

  useEffect(() => {
    getProjects().then(setProjects).catch(() => {})
  }, [])

  useEffect(() => {
    if (autoRefresh === 0 || activeTab !== 'system') return
    const id = setInterval(() => { systemQuery.refetch() }, autoRefresh * 1000)
    return () => clearInterval(id)
  }, [autoRefresh, activeTab, systemQuery])

  const handleRefreshProcesses = async () => {
    setRefreshing(true)
    await systemQuery.refetch()
    setRefreshing(false)
  }

  if (isLoading && !data) {
    return (
      <div class={styles.page}>
        <div class={styles.loading}>Loading stats...</div>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div class={styles.page}>
        <div class={styles.error}>{error.message}</div>
      </div>
    )
  }

  if (!data) return null

  const { memories, projects: projectStats, tags, relations, files, database, health } = data

  const connectivityPct = health && health.total_memories > 0
    ? Math.round((health.connected_count / health.total_memories) * 100)
    : 0

  const sortedProcesses = useMemo(() => {
    if (!processes?.processes) return []
    const list = [...processes.processes]
    const dir = processSort.direction === 'asc' ? 1 : -1
    if (processSort.field === 'name') {
      list.sort((a, b) => dir * a.name.localeCompare(b.name))
    } else if (processSort.field === 'cpu') {
      list.sort((a, b) => dir * (a.cpu - b.cpu))
    } else {
      list.sort((a, b) => dir * (a.rss - b.rss))
    }
    return list
  }, [processes, processSort])

  const sortedSystemProcesses = useMemo(() => {
    if (!system_processes?.apps) return []
    const list = [...system_processes.apps]
    const dir = systemSort.direction === 'asc' ? 1 : -1
    if (systemSort.field === 'name') {
      list.sort((a, b) => dir * a.name.localeCompare(b.name))
    } else if (systemSort.field === 'cpu') {
      list.sort((a, b) => dir * (a.cpu - b.cpu))
    } else {
      list.sort((a, b) => dir * (a.rss - b.rss))
    }
    return list
  }, [system_processes, systemSort])

  const nonZeroTypes = memories.by_type.filter((t) => t.count > 0)
  const maxByType = Math.max(...nonZeroTypes.map((t) => t.count), 1)
  const maxByProject = Math.max(...memories.by_project.map((p) => p.count), 1)

  return (
    <div class={styles.page}>
      {/* Toolbar */}
      <div class={styles.toolbar} data-testid="stats-page--toolbar">
        <h1 class={styles.title}>Stats</h1>
        <div class={styles.toolbarControls}>
          <select
            class={styles.projectSelect}
            value={selectedProject}
            onChange={(e) => setSelectedProject((e.target as HTMLSelectElement).value)}
            data-testid="stats-page--project-filter"
          >
            <option value="">All Projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.handle}>{p.display_name || p.name}</option>
            ))}
          </select>
          <div class={styles.timeRangePills} data-testid="stats-page--time-range">
            {TIME_RANGES.map((tr) => (
              <button
                key={tr.key}
                type="button"
                class={`${styles.timePill} ${timeRange === tr.key ? styles.timePillActive : ''}`}
                onClick={() => setTimeRange(tr.key)}
              >
                {tr.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <TabBar
        tabs={TABS}
        activeKey={activeTab}
        onChange={(k) => { setActiveTab(k as TabKey); sessionStorage.setItem('stats-tab', k) }}
      />

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div class={styles.tabContent} data-testid="stats-page--overview-tab">
          {/* Summary cards */}
          <div class={styles.cardGrid}>
            <div class={styles.statCard}>
              <span class={styles.statLabel}>Memories</span>
              <span class={styles.statValue}>{memories.total}</span>
              <span class={styles.statSub}>{nonZeroTypes.length} active types</span>
            </div>
            <div class={styles.statCard}>
              <span class={styles.statLabel}>Projects</span>
              <span class={styles.statValue}>{projectStats.total}</span>
            </div>
            <div class={styles.statCard}>
              <span class={styles.statLabel}>Tags</span>
              <span class={styles.statValue}>{tags.total}</span>
            </div>
            <div class={styles.statCard}>
              <span class={styles.statLabel}>Relations</span>
              <span class={styles.statValue}>{relations.total}</span>
              <span class={styles.statSub}>{relations.by_type.length} types used</span>
            </div>
            <div class={styles.statCard}>
              <span class={styles.statLabel}>Files</span>
              <span class={styles.statValue}>{files.total}</span>
              {files.total_size > 0 && (
                <span class={styles.statSub}>{formatBytes(files.total_size)}</span>
              )}
            </div>
            <div class={styles.statCard}>
              <span class={styles.statLabel}>Database</span>
              <span class={styles.statValue}>{database.size_human}</span>
            </div>
          </div>

          {/* Health indicators */}
          {health && (
            <div class={styles.healthStrip} data-testid="stats-page--health-strip">
              <div class={`${styles.healthItem} ${health.stale_todos > 0 ? styles.healthWarn : ''}`}>
                <AlertTriangle size={14} />
                <span class={styles.healthValue}>{health.stale_todos}</span>
                <span class={styles.healthLabel}>Stale Todos</span>
              </div>
              <div class={`${styles.healthItem} ${health.orphan_count > 20 ? styles.healthWarn : ''}`}>
                <Unlink size={14} />
                <span class={styles.healthValue}>{health.orphan_count}</span>
                <span class={styles.healthLabel}>Orphans</span>
              </div>
              <div class={styles.healthItem}>
                <Network size={14} />
                <span class={styles.healthValue}>{connectivityPct}%</span>
                <span class={styles.healthLabel}>Connected</span>
              </div>
              <div class={`${styles.healthItem} ${health.pending_decisions > 5 ? styles.healthWarn : ''}`}>
                <HelpCircle size={14} />
                <span class={styles.healthValue}>{health.pending_decisions}</span>
                <span class={styles.healthLabel}>Pending Decisions</span>
              </div>
            </div>
          )}

          {/* Distribution */}
          <div class={styles.columns}>
            <div class={styles.section}>
              <h2 class={styles.sectionTitle}>
                By Type
                <div class={styles.viewToggle}>
                  <button
                    type="button"
                    class={`${styles.viewBtn} ${typeView === 'treemap' ? styles.viewBtnActive : ''}`}
                    onClick={() => setTypeView('treemap')}
                    title="Treemap view"
                  >
                    <LayoutGrid size={14} />
                  </button>
                  <button
                    type="button"
                    class={`${styles.viewBtn} ${typeView === 'bars' ? styles.viewBtnActive : ''}`}
                    onClick={() => setTypeView('bars')}
                    title="Bar view"
                  >
                    <List size={14} />
                  </button>
                </div>
              </h2>
              {typeView === 'treemap' ? (
                <div class={styles.treemap}>
                  {nonZeroTypes.map((t) => {
                    const pct = (t.count / memories.total) * 100
                    const color = TYPE_COLORS[t.type] || 'var(--muted)'
                    return (
                      <div
                        key={t.type}
                        class={styles.treemapCell}
                        style={{
                          flexBasis: `${Math.max(pct, 6)}%`,
                          flexGrow: pct,
                          backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)`,
                          borderColor: color,
                        }}
                        title={`${formatLabel(t.type)}: ${t.count}`}
                      >
                        <span class={styles.treemapLabel} style={{ color }}>{formatLabel(t.type)}</span>
                        <span class={styles.treemapCount}>{t.count}</span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div class={styles.barList}>
                  {nonZeroTypes.map((t) => {
                    const color = TYPE_COLORS[t.type] || 'var(--accent)'
                    return (
                      <div key={t.type} class={styles.barItem}>
                        <div class={styles.barHeader}>
                          <span class={styles.barLabel}>{formatLabel(t.type)}</span>
                          <span class={styles.barCount}>{t.count}</span>
                        </div>
                        <div class={styles.barTrack}>
                          <div
                            class={styles.barFill}
                            style={{ width: `${(t.count / maxByType) * 100}%`, background: color }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div class={styles.section}>
              <h2 class={styles.sectionTitle}>
                By Project
                <div class={styles.viewToggle}>
                  <button
                    type="button"
                    class={`${styles.viewBtn} ${projectView === 'treemap' ? styles.viewBtnActive : ''}`}
                    onClick={() => setProjectView('treemap')}
                    title="Treemap view"
                  >
                    <LayoutGrid size={14} />
                  </button>
                  <button
                    type="button"
                    class={`${styles.viewBtn} ${projectView === 'bars' ? styles.viewBtnActive : ''}`}
                    onClick={() => setProjectView('bars')}
                    title="Bar view"
                  >
                    <List size={14} />
                  </button>
                </div>
              </h2>
              {projectView === 'treemap' ? (
                <div class={styles.treemap}>
                  {memories.by_project.filter((p) => p.count > 0).map((p, i) => {
                    const gradientColors = ['var(--brand-purple)', 'var(--brand-blue)', 'var(--brand-green)', 'var(--node-context)', 'var(--node-command)']
                    const color = gradientColors[i % gradientColors.length]
                    const pct = (p.count / memories.total) * 100
                    return (
                      <a
                        key={p.handle}
                        href={`/projects/${p.id}`}
                        class={styles.treemapCell}
                        style={{
                          flexBasis: `${Math.max(pct, 8)}%`,
                          flexGrow: pct,
                          backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)`,
                          borderColor: color,
                          textDecoration: 'none',
                        }}
                        title={`${p.name}: ${p.count}`}
                      >
                        <span class={styles.treemapLabel} style={{ color }}>{p.name}</span>
                        <span class={styles.treemapCount}>{p.count}</span>
                      </a>
                    )
                  })}
                </div>
              ) : (
                <div class={styles.barList}>
                  {memories.by_project.map((p, i) => {
                    const gradientColors = ['var(--brand-purple)', 'var(--brand-blue)', 'var(--brand-green)', 'var(--node-context)', 'var(--node-command)']
                    const color = gradientColors[i % gradientColors.length]
                    return (
                      <div key={p.handle} class={styles.barItem}>
                        <div class={styles.barHeader}>
                          <a href={`/projects/${p.id}`} class={styles.barLabelLink}>{p.name}</a>
                          <span class={styles.barCount}>{p.count}</span>
                        </div>
                        <div class={styles.barTrack}>
                          <div
                            class={styles.barFill}
                            style={{ width: `${(p.count / maxByProject) * 100}%`, background: color }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Ranked lists */}
          <div class={styles.columns}>
            {tags.top.length > 0 && (
              <div class={styles.section}>
                <h2 class={styles.sectionTitle}>Top Tags</h2>
                <div class={styles.rankedList}>
                  {tags.top.map((t, i) => (
                    <div key={t.name} class={styles.rankedItem}>
                      <span class={styles.rankedRank}>{i + 1}</span>
                      <span class={styles.rankedName}>{t.name}</span>
                      <span class={styles.rankedCount}>{t.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {relations.by_type.length > 0 && (
              <div class={styles.section}>
                <h2 class={styles.sectionTitle}>Relation Types</h2>
                <div class={styles.rankedList}>
                  {relations.by_type.map((r, i) => (
                    <div key={r.type} class={styles.rankedItem}>
                      <span class={styles.rankedRank}>{i + 1}</span>
                      <span class={styles.rankedName}>{formatLabel(r.type)}</span>
                      <span class={styles.rankedCount}>{r.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Footer with date range */}
          {memories.oldest && memories.newest && (
            <div class={styles.footer}>
              Memories spanning {formatDate(memories.oldest)} &mdash; {formatDate(memories.newest)}
            </div>
          )}
        </div>
      )}

      {/* Memory Analysis Tab */}
      {activeTab === 'memory' && (
        <div class={styles.tabContent} data-testid="stats-page--memory-tab">
          {/* Activity Heatmap */}
          {memory_analysis && <ActivityHeatmap dailyCounts={memory_analysis.daily_counts} />}

          {/* Status Breakdown Cards */}
          {memory_analysis && memory_analysis.status_breakdown.length > 0 && (
            <div class={styles.statusGrid}>
              {memory_analysis.status_breakdown.map((tb) => (
                <StatusBreakdownCard key={tb.type} type={tb.type} total={tb.total} statuses={tb.statuses} />
              ))}
            </div>
          )}

          {!memory_analysis && (
            <div class={styles.placeholder}>
              <Brain size={32} />
              <p>No analysis data available</p>
            </div>
          )}
        </div>
      )}

      {/* Claude Usage Tab */}
      {activeTab === 'usage' && (
        <div class={styles.tabContent} data-testid="stats-page--usage-tab">
          {claude_usage && claude_usage.total_sessions > 0 ? (
            <>
              {/* KPI Row */}
              <div class={styles.cardGrid}>
                <div class={styles.statCard}>
                  <span class={styles.statLabel}>Sessions</span>
                  <span class={styles.statValue}>{claude_usage.total_sessions}</span>
                </div>
                <div class={styles.statCard}>
                  <span class={styles.statLabel}>Input Tokens</span>
                  <span class={styles.statValue}>{formatTokens(claude_usage.total_input_tokens)}</span>
                </div>
                <div class={styles.statCard}>
                  <span class={styles.statLabel}>Output Tokens</span>
                  <span class={styles.statValue}>{formatTokens(claude_usage.total_output_tokens)}</span>
                </div>
                <div class={styles.statCard}>
                  <span class={styles.statLabel}>Cache Hit Rate</span>
                  <span class={styles.statValue}>{Math.round(claude_usage.cache_hit_rate * 100)}%</span>
                </div>
                <div class={styles.statCard}>
                  <span class={styles.statLabel}>Cache Tokens</span>
                  <span class={styles.statValue}>{formatTokens(claude_usage.total_cache_read_tokens)}</span>
                  <span class={styles.statSub}>{formatTokens(claude_usage.total_cache_creation_tokens)} created</span>
                </div>
                <div class={styles.statCard}>
                  <span class={styles.statLabel}>API Equivalent</span>
                  <span class={styles.statValue}>{formatCost(claude_usage.estimated_cost)}</span>
                  <span class={styles.statSub}>at per-token rates</span>
                </div>
              </div>

              {/* Weekly Usage + Model Distribution */}
              <div class={styles.columns}>
                {/* Weekly token consumption */}
                {claude_usage.weekly_usage.length > 0 && (
                  <div class={styles.section}>
                    <h2 class={styles.sectionTitle}>Weekly Token Usage</h2>
                    <div class={styles.weeklyChart}>
                      {(() => {
                        const weeks = claude_usage!.weekly_usage
                        const maxWeek = Math.max(...weeks.map((w) => w.input_tokens + w.output_tokens + w.cache_read_tokens), 1)
                        return weeks.map((w) => {
                          const total = w.input_tokens + w.output_tokens + w.cache_read_tokens
                          const inputPct = (w.input_tokens / maxWeek) * 100
                          const outputPct = (w.output_tokens / maxWeek) * 100
                          const cachePct = (w.cache_read_tokens / maxWeek) * 100
                          const weekLabel = new Date(w.week).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                          return (
                            <div key={w.week} class={styles.weeklyBarCol} title={`${weekLabel}: ${formatTokens(total)} total`}>
                              <div class={styles.weeklyBarStack}>
                                {cachePct > 0 && <div class={styles.weeklySegCache} style={{ height: `${cachePct}%` }} />}
                                {outputPct > 0 && <div class={styles.weeklySegOutput} style={{ height: `${outputPct}%` }} />}
                                {inputPct > 0 && <div class={styles.weeklySegInput} style={{ height: `${inputPct}%` }} />}
                              </div>
                              <span class={styles.weeklyLabel}>{weekLabel}</span>
                            </div>
                          )
                        })
                      })()}
                    </div>
                    <div class={styles.weeklyLegend}>
                      <span class={styles.weeklyLegendItem}><span class={styles.weeklyLegendDot} style={{ backgroundColor: 'var(--brand-purple)' }} /> Input</span>
                      <span class={styles.weeklyLegendItem}><span class={styles.weeklyLegendDot} style={{ backgroundColor: 'var(--brand-blue)' }} /> Output</span>
                      <span class={styles.weeklyLegendItem}><span class={styles.weeklyLegendDot} style={{ backgroundColor: 'var(--brand-green)' }} /> Cache Read</span>
                    </div>
                  </div>
                )}

                {/* Model distribution */}
                {claude_usage.by_model.length > 0 && (
                  <div class={styles.section}>
                    <h2 class={styles.sectionTitle}>Model Distribution</h2>
                    {(() => {
                      const models = claude_usage!.by_model.filter((m) => m.session_count > 0)
                      const totalSessions = models.reduce((s, m) => s + m.session_count, 0)
                      // SVG donut
                      const size = 140
                      const cx = size / 2
                      const cy = size / 2
                      const r = 52
                      const strokeWidth = 20
                      const circumference = 2 * Math.PI * r
                      let offset = 0

                      return (
                        <div class={styles.donutContainer}>
                          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                            {models.map((m) => {
                              const pct = m.session_count / totalSessions
                              const dash = pct * circumference
                              const gap = circumference - dash
                              const color = getModelColor(m.model)
                              const segment = (
                                <circle
                                  key={m.model}
                                  cx={cx}
                                  cy={cy}
                                  r={r}
                                  fill="none"
                                  stroke={color}
                                  stroke-width={strokeWidth}
                                  stroke-dasharray={`${dash} ${gap}`}
                                  stroke-dashoffset={-offset}
                                  transform={`rotate(-90 ${cx} ${cy})`}
                                />
                              )
                              offset += dash
                              return segment
                            })}
                            <text x={cx} y={cy - 4} text-anchor="middle" class={styles.donutCenter}>{totalSessions}</text>
                            <text x={cx} y={cy + 12} text-anchor="middle" class={styles.donutCenterSub}>sessions</text>
                          </svg>
                          <div class={styles.donutLegend}>
                            {models.map((m) => {
                              const pct = Math.round((m.session_count / totalSessions) * 100)
                              return (
                                <div key={m.model} class={styles.donutLegendItem}>
                                  <span class={styles.donutLegendDot} style={{ backgroundColor: getModelColor(m.model) }} />
                                  <span class={styles.donutLegendName}>{formatModelName(m.model)}</span>
                                  <span class={styles.donutLegendValue}>{pct}%</span>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                )}
              </div>

              {/* Usage by Project */}
              {claude_usage.by_project.length > 0 && (
                <div class={styles.section}>
                  <h2 class={styles.sectionTitle}>
                    Usage by Project
                    <span class={styles.sectionSub}>top {claude_usage.by_project.length}</span>
                  </h2>
                  <table class={styles.usageTable}>
                    <thead>
                      <tr>
                        <th>Project</th>
                        <th>Sessions</th>
                        <th>Tokens</th>
                        <th>API Equiv.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {claude_usage.by_project.map((p) => (
                        <tr key={p.project}>
                          <td>
                            {p.id ? (
                              <a href={`/projects/${p.id}`} class={styles.barLabelLink}>{p.name}</a>
                            ) : (
                              <span class={styles.barLabel}>{p.name}</span>
                            )}
                          </td>
                          <td class={styles.numCell}>{p.session_count}</td>
                          <td class={styles.numCell}>{formatTokens(p.total_tokens)}</td>
                          <td class={styles.numCell}>{formatCost(p.estimated_cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Recent Sessions */}
              {claude_usage.recent_sessions.length > 0 && (
                <div class={styles.section}>
                  <h2 class={styles.sectionTitle}>Recent Sessions</h2>
                  <table class={styles.usageTable}>
                    <thead>
                      <tr>
                        <th>Session</th>
                        <th>Project</th>
                        <th>Model</th>
                        <th>Messages</th>
                        <th>Tokens</th>
                        <th>Context</th>
                      </tr>
                    </thead>
                    <tbody>
                      {claude_usage.recent_sessions.map((s, i) => {
                        const ctxTokens = s.context_window_tokens
                        const maxTokens = getContextWindowSize(s.model)
                        const pct = ctxTokens && maxTokens ? Math.round((ctxTokens / maxTokens) * 100) : null
                        return (
                        <tr key={i}>
                          <td>{s.nickname || 'unnamed'}</td>
                          <td>
                            {s.project ? (
                              <a href={`/projects/${s.project}`} class={styles.barLabelLink}>{s.project_name || s.project}</a>
                            ) : (
                              <span class={styles.barLabel}>—</span>
                            )}
                          </td>
                          <td>
                            {s.model && (
                              <span class={styles.modelTag} style={{ borderColor: getModelColor(s.model) }}>
                                {formatModelName(s.model)}
                              </span>
                            )}
                          </td>
                          <td class={styles.numCell}>{s.messages}</td>
                          <td class={styles.numCell}>{formatTokens(s.total_input + s.total_output)}</td>
                          <td class={styles.numCell}>
                            {ctxTokens && ctxTokens > 0 ? (
                              <span class={styles.contextCell} title={`${formatTokens(ctxTokens)}${maxTokens ? ` / ${formatTokens(maxTokens)}` : ''} tokens`}>
                                {maxTokens && (
                                  <span class={styles.contextBar}>
                                    <span class={styles.contextFill} style={{ width: `${Math.min(pct!, 100)}%` }} />
                                  </span>
                                )}
                                {formatTokens(ctxTokens)}{maxTokens ? `/${formatTokens(maxTokens)}` : ''}
                              </span>
                            ) : '—'}
                          </td>
                        </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Methodology note */}
              <div class={styles.usageNote}>
                <p><strong>How this is calculated</strong></p>
                <p>Token counts are parsed from <code>message.usage</code> in session JSONL files during sync. Each assistant turn reports input, output, cache read, and cache creation tokens.</p>
                <p><strong>Cache tokens:</strong> Cache read = context served from Anthropic's prompt cache (not re-transmitted). Cache creation = context written to cache. These dominate total token volume in long sessions.</p>
                <p><strong>API equivalent cost</strong> uses published per-token rates: Opus $15/$75 per MTok (input/output), Sonnet $3/$15, Haiku $0.80/$4. Cache reads are 90% cheaper than input; cache writes 25% more. Subscription plans (Pro $20/mo, Max $100/mo) include all usage at a flat rate — the API equivalent shows what this usage would cost without a subscription.</p>
              </div>
            </>
          ) : (
            <div class={styles.placeholder}>
              <Zap size={32} />
              <p>No usage data available</p>
              <span class={styles.placeholderSub}>Session usage data is collected during sync. Try running a force sync.</span>
            </div>
          )}
        </div>
      )}

      {/* System Tab */}
      {activeTab === 'system' && (
        <div class={styles.tabContent} data-testid="stats-page--system-tab">
          <div class={styles.systemHeader}>
            <div class={styles.subTabs}>
              <button
                type="button"
                class={`${styles.subTab} ${systemSubTab === 'system' ? styles.subTabActive : ''}`}
                onClick={() => setSystemSubTab('system')}
              >
                System
                {system_processes && <span class={styles.subTabBadge}>{system_processes.total_rss_human}</span>}
              </button>
              <button
                type="button"
                class={`${styles.subTab} ${systemSubTab === 'khef' ? styles.subTabActive : ''}`}
                onClick={() => setSystemSubTab('khef')}
              >
                Khef
                {processes && <span class={styles.subTabBadge}>{processes.total_rss_human}</span>}
              </button>
            </div>
            <div class={styles.refreshControls}>
              <div class={styles.autoRefreshPills}>
                {[{ value: 0, label: 'Off' }, { value: 5, label: '5s' }, { value: 30, label: '30s' }, { value: 60, label: '1m' }].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    class={`${styles.autoRefreshPill} ${autoRefresh === opt.value ? styles.autoRefreshPillActive : ''}`}
                    onClick={() => setAutoRefresh(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <button
                class={styles.refreshBtn}
                onClick={handleRefreshProcesses}
                disabled={refreshing}
                title="Refresh process memory"
              >
                <RefreshCw size={14} class={refreshing ? styles.spinning : undefined} />
              </button>
            </div>
          </div>

          {/* Khef processes */}
          {systemSubTab === 'khef' && (
            <>
              {processes && processes.processes.length > 0 ? (
                <div class={styles.section}>
                  <SortBar
                    fields={[{ key: 'name', label: 'Name' }, { key: 'cpu', label: 'CPU' }, { key: 'rss', label: 'Memory' }]}
                    value={processSort}
                    onChange={setProcessSort}
                  />
                  <div class={styles.barList}>
                    {sortedProcesses.map((p) => {
                      const isExpanded = expandedGroups.has(p.name)
                      const canExpand = p.count > 1
                      const toggleExpand = () => {
                        setExpandedGroups((prev) => {
                          const next = new Set(prev)
                          if (next.has(p.name)) next.delete(p.name)
                          else next.add(p.name)
                          return next
                        })
                      }
                      return (
                        <div key={p.name} class={styles.barItem}>
                          <div
                            class={`${styles.barHeader} ${canExpand ? styles.barHeaderExpandable : ''}`}
                            onClick={canExpand ? toggleExpand : undefined}
                          >
                            <span class={styles.barLabel}>
                              {canExpand && (
                                <ChevronRight
                                  size={12}
                                  class={`${styles.expandIcon} ${isExpanded ? styles.expandIconOpen : ''}`}
                                />
                              )}
                              {p.name}
                              {canExpand && <span class={styles.processCount}> ({p.count})</span>}
                            </span>
                            <span class={styles.barStats}>
                              {p.cpu > 0 && <span class={styles.cpuBadge}>{p.cpu}%</span>}
                              <span class={styles.barCount}>{p.rss_human}</span>
                            </span>
                          </div>
                          <div class={styles.barTrack}>
                            <div
                              class={styles.barFill}
                              style={{ width: `${(p.rss / processes.total_rss) * 100}%` }}
                            />
                          </div>
                          {isExpanded && p.instances && (
                            <div class={styles.instanceList}>
                              {p.instances.map((inst) => (
                                <div
                                  key={inst.pid}
                                  class={styles.instanceItem}
                                  onContextMenu={(e) => handleInstanceContextMenu(e, inst.pid, inst.name)}
                                >
                                  <span class={styles.instancePid}>
                                    PID {inst.pid}
                                    {inst.name && <span class={styles.instanceName}>{inst.name}</span>}
                                    {inst.session_nickname && inst.session_id && (
                                      <Link
                                        href={`/sessions/${inst.session_id}`}
                                        class={styles.instanceSession}
                                        title={`Session ${inst.session_nickname}`}
                                      >
                                        {inst.session_nickname}
                                      </Link>
                                    )}
                                  </span>
                                  <span class={styles.instanceStats}>
                                    {inst.cpu > 0 && <span class={styles.cpuBadge}>{inst.cpu}%</span>}
                                    <span>{inst.rss_human}</span>
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <div class={styles.placeholder}>
                  <Cpu size={32} />
                  <p>No khef processes detected</p>
                </div>
              )}
            </>
          )}

          {/* System processes */}
          {systemSubTab === 'system' && (
            <>
              {system_processes && system_processes.apps.length > 0 ? (
                <div class={styles.section}>
                  <SortBar
                    fields={[{ key: 'name', label: 'Name' }, { key: 'cpu', label: 'CPU' }, { key: 'rss', label: 'Memory' }]}
                    value={systemSort}
                    onChange={setSystemSort}
                  />
                  <div class={styles.barList}>
                    {sortedSystemProcesses.map((app) => {
                      const isExpanded = expandedSystemGroups.has(app.name)
                      const canExpand = app.count > 1 && app.instances && app.instances.length > 1
                      const toggleExpand = () => {
                        setExpandedSystemGroups((prev) => {
                          const next = new Set(prev)
                          if (next.has(app.name)) next.delete(app.name)
                          else next.add(app.name)
                          return next
                        })
                      }
                      return (
                        <div key={app.name} class={styles.barItem}>
                          <div
                            class={`${styles.barHeader} ${canExpand ? styles.barHeaderExpandable : ''}`}
                            onClick={canExpand ? toggleExpand : undefined}
                          >
                            <span class={styles.barLabel}>
                              {canExpand && (
                                <ChevronRight
                                  size={12}
                                  class={`${styles.expandIcon} ${isExpanded ? styles.expandIconOpen : ''}`}
                                />
                              )}
                              {app.name}
                              {app.count > 1 && <span class={styles.processCount}> ({app.count})</span>}
                            </span>
                            <span class={styles.barStats}>
                              {app.cpu > 0 && <span class={styles.cpuBadge}>{app.cpu}%</span>}
                              <span class={styles.barCount}>{app.rss_human}</span>
                            </span>
                          </div>
                          <div class={styles.barTrack}>
                            <div
                              class={styles.barFill}
                              style={{ width: `${(app.rss / system_processes.total_rss) * 100}%` }}
                            />
                          </div>
                          {isExpanded && app.instances && (
                            <div class={styles.instanceList}>
                              {app.instances.map((inst) => (
                                <div
                                  key={inst.pid}
                                  class={styles.instanceItem}
                                  onContextMenu={(e) => handleInstanceContextMenu(e, inst.pid, inst.name)}
                                >
                                  <span class={styles.instancePid}>
                                    PID {inst.pid}
                                    {inst.name && <span class={styles.instanceName}>{inst.name}</span>}
                                    {inst.session_nickname && inst.session_id && (
                                      <Link
                                        href={`/sessions/${inst.session_id}`}
                                        class={styles.instanceSession}
                                        title={`Session ${inst.session_nickname}`}
                                      >
                                        {inst.session_nickname}
                                      </Link>
                                    )}
                                  </span>
                                  <span class={styles.instanceStats}>
                                    {inst.cpu > 0 && <span class={styles.cpuBadge}>{inst.cpu}%</span>}
                                    <span>{inst.rss_human}</span>
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <div class={styles.placeholder}>
                  <Cpu size={32} />
                  <p>No system process data available</p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {contextMenu && (
        <div
          ref={menuRef}
          class={styles.contextMenu}
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            class={styles.contextMenuItem}
            onClick={() => copyPid(contextMenu.pid)}
          >
            <span>Copy PID {contextMenu.pid}</span>
            <Copy size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
