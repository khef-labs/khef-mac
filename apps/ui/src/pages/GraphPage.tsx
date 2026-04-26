import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import panzoom from 'panzoom'
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Download,
} from 'lucide-preact'
import { getMemoryGraph, getMemory, getProject, previewDiagram } from '../lib/api'
import { generateDot, detectTheme, type GraphDirection } from '../lib/graphviz'
import type { GraphData, MemoryType, Memory, Project } from '../types'
import { useDocumentTitle } from '../hooks'
import styles from './GraphPage.module.css'

interface Props {
  memoryId?: string
  projectId?: string
}

// Memory types that appear as node type filters
const FILTERABLE_TYPES: MemoryType[] = [
  'decision',
  'pattern',
  'context',
  'user-todo',
  'assistant-todo',
  'user-note',
  'assistant-note',
  'project-note',
  'command',
  'commands',
  'api',
  'reference',
  'assistant-rule',
  'diagram',
  'knowledge',
]

// Short labels for type filter chips
const TYPE_LABELS: Partial<Record<MemoryType, string>> = {
  'user-todo': 'u-todo',
  'assistant-todo': 'a-todo',
  'user-note': 'u-note',
  'assistant-note': 'a-note',
  'project-note': 'p-note',
  'assistant-rule': 'rule',
}

// Node colors (duplicated from graphviz.ts for chip styling)
const TYPE_COLORS: Record<string, string> = {
  decision: '#8b5cf6',
  pattern: '#06b6d4',
  context: '#f59e0b',
  'user-todo': '#10b981',
  'assistant-todo': '#10b981',
  'user-note': '#6b7280',
  'assistant-note': '#6b7280',
  'project-note': '#6b7280',
  command: '#ec4899',
  commands: '#ec4899',
  api: '#3b82f6',
  reference: '#64748b',
  'assistant-rule': '#f43f5e',
  diagram: '#a855f7',
  knowledge: '#f59e0b',
}

export function GraphPage({ memoryId, projectId }: Props) {
  const [, setLocation] = useLocation()

  // Graph data
  const [graphData, setGraphData] = useState<GraphData | null>(null)
  const [svgContent, setSvgContent] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRendering, setIsRendering] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Context info
  const [memory, setMemory] = useState<Memory | null>(null)
  const [project, setProject] = useState<Project | null>(null)

  const graphLabel = memory?.title || project?.display_name || project?.name
  useDocumentTitle(graphLabel ? `Graph - ${graphLabel}` : 'Graph')

  // Controls
  const [depth, setDepth] = useState(10) // Start high to discover max depth
  const [maxDepth, setMaxDepth] = useState<number | null>(null)
  const [direction, setDirection] = useState<GraphDirection>('LR')
  const [excludeTypes, setExcludeTypes] = useState<Set<MemoryType>>(new Set())

  // Panzoom
  const containerRef = useRef<HTMLDivElement>(null)
  const panzoomRef = useRef<ReturnType<typeof panzoom> | null>(null)

  // Determine which types actually exist in the graph data
  const presentTypes = useMemo(() => {
    if (!graphData) return []
    const typeSet = new Set(graphData.nodes.map((n) => n.type))
    return FILTERABLE_TYPES.filter((t) => typeSet.has(t))
  }, [graphData])

  // Back navigation URL
  const backUrl = memoryId
    ? `/memories/${memoryId}`
    : projectId
      ? `/projects/${projectId}`
      : '/search'


  // Fetch graph data
  const fetchGraph = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      if (memoryId) {
        const [graph, mem] = await Promise.all([
          getMemoryGraph(memoryId, { depth, compact: true, max_nodes: 150, max_edges: 300 }),
          memory ? Promise.resolve(memory) : getMemory(memoryId).catch(() => null),
        ])
        setGraphData(graph)
        if (graph.max_depth !== undefined && maxDepth === null) {
          const detected = Math.max(1, graph.max_depth)
          setMaxDepth(detected)
          if (depth > detected) setDepth(detected)
        }
        if (mem) setMemory(mem)

        // Fetch project info if we have a memory
        if (mem?.project_id && !project) {
          getProject(mem.project_id).then(setProject).catch(() => {})
        }
      } else if (projectId) {
        // Project-level graph - use the project graph endpoint
        const [graph, proj] = await Promise.all([
          fetchProjectGraph(projectId, depth),
          project ? Promise.resolve(project) : getProject(projectId).catch(() => null),
        ])
        setGraphData(graph)
        if (proj) setProject(proj)
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load graph data')
    } finally {
      setIsLoading(false)
    }
  }, [memoryId, projectId, depth])

  // Fetch project-level graph (via the API endpoint)
  async function fetchProjectGraph(projId: string, graphDepth: number): Promise<GraphData> {
    const API_BASE =
      (import.meta.env.KHEF_API_URL as string | undefined) ||
      (typeof window !== 'undefined' && window.location?.origin
        ? `${window.location.origin}/api`
        : 'http://localhost:3000/api')

    const params = new URLSearchParams({
      depth: String(graphDepth),
      max_nodes: '150',
      max_edges: '300',
      compact: 'true',
    })

    const res = await fetch(`${API_BASE}/projects/${projId}/graph?${params}`)
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.error || `Failed to fetch project graph: ${res.status}`)
    }
    return res.json()
  }

  // Render DOT to SVG via Kroki
  const renderGraph = useCallback(async () => {
    if (!graphData || graphData.nodes.length === 0) {
      setSvgContent(null)
      return
    }

    setIsRendering(true)
    try {
      const theme = detectTheme()
      const dot = generateDot(graphData, {
        focusNodeId: memoryId,
        direction,
        excludeTypes: excludeTypes.size > 0 ? excludeTypes : undefined,
        dark: theme === 'dark',
      })

      const { svg } = await previewDiagram('graphviz', dot, theme)
      setSvgContent(svg)
    } catch (err: any) {
      setError(err.message || 'Failed to render graph')
    } finally {
      setIsRendering(false)
    }
  }, [graphData, memoryId, direction, excludeTypes])

  // Fetch on mount and when depth changes
  useEffect(() => {
    fetchGraph()
  }, [fetchGraph])

  // Re-render when graphData, direction, or filters change
  useEffect(() => {
    if (graphData) {
      renderGraph()
    }
  }, [renderGraph])

  // Initialize panzoom when SVG is rendered
  useEffect(() => {
    if (!svgContent || !containerRef.current) return

    const instance = panzoom(containerRef.current, {
      maxZoom: 10,
      minZoom: 0.1,
      smoothScroll: false,
      zoomDoubleClickSpeed: 1,
    })
    panzoomRef.current = instance

    return () => {
      instance.dispose()
      panzoomRef.current = null
    }
  }, [svgContent])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when user is in an input
      if ((e.target as HTMLElement)?.tagName === 'SELECT') return

      if (e.key === 'Escape') {
        setLocation(backUrl)
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        const p = panzoomRef.current
        if (p) p.zoomAbs(0, 0, p.getTransform().scale * 1.2)
      } else if (e.key === '-') {
        e.preventDefault()
        const p = panzoomRef.current
        if (p) p.zoomAbs(0, 0, p.getTransform().scale / 1.2)
      } else if (e.key === '0') {
        e.preventDefault()
        panzoomRef.current?.moveTo(0, 0)
        panzoomRef.current?.zoomAbs(0, 0, 1)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [backUrl, setLocation])

  // Intercept clicks on SVG <a> elements for SPA navigation
  const handleSvgClick = useCallback(
    (e: MouseEvent) => {
      // Walk up from target to find an <a> element
      let el = e.target as Element | null
      while (el && el !== containerRef.current) {
        if (el.tagName === 'a' || el.tagName === 'A') {
          const href =
            el.getAttribute('xlink:href') ||
            el.getAttribute('href')
          if (href?.startsWith('/memories/')) {
            e.preventDefault()
            e.stopPropagation()
            setLocation(href)
            return
          }
        }
        el = el.parentElement
      }
    },
    [setLocation]
  )

  // Export SVG as file download
  const handleExportSvg = useCallback(() => {
    if (!svgContent) return
    // Fix unclosed HTML tags that break XML parsing
    let sanitized = svgContent.replace(/<br\s*>/gi, '<br/>')
    sanitized = sanitized.replace(/<hr\s*>/gi, '<hr/>')
    const blob = new Blob([sanitized], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `graph-${memoryId || projectId || 'export'}.svg`
    a.click()
    URL.revokeObjectURL(url)
  }, [svgContent, memoryId, projectId])

  // Toggle a type filter
  const toggleType = useCallback((type: MemoryType) => {
    setExcludeTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) {
        next.delete(type)
      } else {
        next.add(type)
      }
      return next
    })
  }, [])

  // Zoom controls
  const zoomIn = () => {
    const p = panzoomRef.current
    if (p) p.zoomAbs(0, 0, p.getTransform().scale * 1.3)
  }
  const zoomOut = () => {
    const p = panzoomRef.current
    if (p) p.zoomAbs(0, 0, p.getTransform().scale / 1.3)
  }
  const zoomReset = () => {
    panzoomRef.current?.moveTo(0, 0)
    panzoomRef.current?.zoomAbs(0, 0, 1)
  }

  // Title
  const pageTitle = memory
    ? memory.title
    : project
      ? project.display_name || project.name
      : memoryId
        ? `Memory ${memoryId.slice(0, 8)}...`
        : projectId || 'Graph'

  // Visible node/edge counts (after type filtering)
  const visibleNodeCount = graphData
    ? graphData.nodes.filter((n) => !excludeTypes.has(n.type)).length
    : 0
  const visibleEdgeCount = graphData
    ? graphData.edges.filter(
        (e) =>
          !excludeTypes.has(graphData.nodes.find((n) => n.id === e.source)?.type as MemoryType) &&
          !excludeTypes.has(graphData.nodes.find((n) => n.id === e.target)?.type as MemoryType)
      ).length
    : 0

  return (
    <div class={styles.page}>
      {/* Toolbar */}
      <div class={styles.toolbar}>

        <span class={styles.title}>{pageTitle}</span>

        <div class={styles.separator} />

        {/* Depth control */}
        {maxDepth !== null && maxDepth > 0 && (
          <div class={styles.controlGroup}>
            <span class={styles.controlLabel}>Depth</span>
            <select
              class={styles.controlSelect}
              value={depth}
              onChange={(e) => setDepth(Number((e.target as HTMLSelectElement).value))}
            >
              {Array.from({ length: maxDepth }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Direction toggle */}
        <button
          class={`${styles.toggleButton} ${styles.directionToggle}`}
          onClick={() => setDirection((d) => (d === 'LR' ? 'TB' : 'LR'))}
          title={`Layout: ${direction === 'LR' ? 'Left to Right' : 'Top to Bottom'}`}
        >
          {direction}
        </button>

        {/* Type filter chips */}
        {presentTypes.length > 1 && (
          <>
            <div class={styles.separator} />
            <div class={styles.typeFilters}>
              {presentTypes.map((type) => {
                const active = !excludeTypes.has(type)
                const color = TYPE_COLORS[type] || '#6b7280'
                return (
                  <button
                    key={type}
                    class={`${styles.typeChip} ${active ? styles.typeChipActive : ''}`}
                    style={active ? { backgroundColor: color } : undefined}
                    onClick={() => toggleType(type)}
                    title={active ? `Hide ${type}` : `Show ${type}`}
                  >
                    {TYPE_LABELS[type] || type}
                  </button>
                )
              })}
            </div>
          </>
        )}

        <div class={styles.spacer} />

        {/* Export */}
        <button
          class={styles.toolbarButton}
          onClick={handleExportSvg}
          disabled={!svgContent}
          title="Export SVG"
        >
          <Download size={16} />
        </button>
      </div>

      {/* Graph viewport */}
      <div class={styles.viewport}>
        {isLoading ? (
          <div class={styles.loading}>Loading graph data...</div>
        ) : error ? (
          <div class={styles.error}>
            <span>{error}</span>
            <button class={styles.errorRetry} onClick={fetchGraph}>
              Retry
            </button>
          </div>
        ) : !svgContent && !isRendering ? (
          <div class={styles.loading}>No graph data available</div>
        ) : isRendering ? (
          <div class={styles.loading}>Rendering graph...</div>
        ) : (
          <div
            class={styles.graphContainer}
            ref={containerRef}
            onClick={handleSvgClick}
            dangerouslySetInnerHTML={{ __html: svgContent! }}
          />
        )}

        {/* Zoom controls */}
        {svgContent && !isLoading && !error && (
          <div class={styles.zoomControls}>
            <button class={styles.zoomButton} onClick={zoomIn} title="Zoom in (+)">
              <ZoomIn size={18} />
            </button>
            <button class={styles.zoomButton} onClick={zoomOut} title="Zoom out (-)">
              <ZoomOut size={18} />
            </button>
            <button class={styles.zoomButton} onClick={zoomReset} title="Reset zoom (0)">
              <Maximize2 size={18} />
            </button>
          </div>
        )}
      </div>

      {/* Status bar */}
      {graphData && (
        <div class={styles.statusBar}>
          <span>
            {visibleNodeCount} node{visibleNodeCount !== 1 ? 's' : ''},{' '}
            {visibleEdgeCount} edge{visibleEdgeCount !== 1 ? 's' : ''}
            {excludeTypes.size > 0 && ` (${excludeTypes.size} type${excludeTypes.size !== 1 ? 's' : ''} hidden)`}
          </span>
          {graphData.truncated && (
            <span class={styles.truncatedWarning}>
              Graph truncated — showing {graphData.nodes.length} of {graphData.total_nodes || '?'} nodes
            </span>
          )}
        </div>
      )}
    </div>
  )
}
