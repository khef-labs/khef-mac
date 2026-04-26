import type { GraphData, GraphNode, MemoryType } from '../types'

export type GraphDirection = 'LR' | 'TB'

export interface GraphvizOptions {
  /** Root memory ID to highlight with thicker border */
  focusNodeId?: string
  /** Layout direction: left-to-right or top-to-bottom */
  direction?: GraphDirection
  /** Memory types to exclude from the output */
  excludeTypes?: Set<MemoryType>
  /** Use dark theme colors (default: true) */
  dark?: boolean
}

// Node fill colors by memory type (from tokens.css --node-* variables)
const NODE_COLORS: Record<string, string> = {
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
  csv: '#14b8a6',
  video: '#e11d48',
  canvas: '#0ea5e9',
  widget: '#0ea5e9',
  animation: '#0ea5e9',
  prototype: '#0ea5e9',
  quiz: '#0ea5e9',
  knowledge: '#f59e0b',
}

const DEFAULT_NODE_COLOR = '#6b7280'

// Relation type labels for edge display
const RELATION_LABELS: Record<string, string> = {
  supports: 'supports',
  contradicts: 'contradicts',
  depends_on: 'depends on',
  follows_from: 'follows from',
  references: 'references',
  relates_to: 'relates to',
  supersedes: 'supersedes',
  implements: 'implements',
  blocks: 'blocks',
  extends: 'extends',
  duplicates: 'duplicates',
}

/** Escape strings for DOT HTML-like labels */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Escape strings for DOT quoted attribute values */
function escapeDot(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Truncate a string with ellipsis */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 1) + '\u2026'
}

/** Determine display type label, preferring parent_type for knowledge children */
function typeLabel(node: GraphNode): string {
  if (node.parent_type) return node.type
  return node.type
}

/** Pick a contrasting font color for a given background hex */
function fontColor(bgHex: string): string {
  // Parse hex
  const r = parseInt(bgHex.slice(1, 3), 16)
  const g = parseInt(bgHex.slice(3, 5), 16)
  const b = parseInt(bgHex.slice(5, 7), 16)
  // Relative luminance (simplified)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.5 ? '#1a1a1a' : '#ffffff'
}

/**
 * Convert GraphData into a Graphviz DOT string suitable for rendering via Kroki.
 */
export function generateDot(data: GraphData, options: GraphvizOptions = {}): string {
  const {
    focusNodeId,
    direction = 'LR',
    excludeTypes,
    dark = true,
  } = options

  // Filter nodes by type
  const nodes = excludeTypes
    ? data.nodes.filter((n) => !excludeTypes.has(n.type))
    : data.nodes

  const nodeIds = new Set(nodes.map((n) => n.id))

  // Filter edges to only include nodes that survived type filtering
  const edges = data.edges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target)
  )

  // Theme-dependent values
  const graphBg = dark ? '#0f0f0f' : '#ffffff'
  const edgeColor = dark ? '#4b5563' : '#9ca3af'
  const edgeFontColor = dark ? '#9ca3af' : '#6b7280'

  const lines: string[] = []

  lines.push('digraph G {')
  lines.push(`  rankdir="${direction}"`)
  lines.push(`  bgcolor="${graphBg}"`)
  lines.push('  pad="0.5"')
  lines.push('  nodesep="0.6"')
  lines.push('  ranksep="0.8"')
  lines.push('')

  // Default node attributes
  lines.push('  node [')
  lines.push('    shape="plain"')
  lines.push('    style="filled"')
  lines.push('  ]')
  lines.push('')

  // Default edge attributes
  lines.push('  edge [')
  lines.push(`    color="${edgeColor}"`)
  lines.push(`    fontcolor="${edgeFontColor}"`)
  lines.push('    fontsize="10"')
  lines.push('    fontname="Helvetica"')
  lines.push('    arrowsize="0.7"')
  lines.push('  ]')
  lines.push('')

  // Nodes
  for (const node of nodes) {
    const color = NODE_COLORS[node.type] || DEFAULT_NODE_COLOR
    const fc = fontColor(color)
    const isFocus = node.id === focusNodeId
    const title = escapeHtml(truncate(node.title, 40))
    const typeLbl = escapeHtml(typeLabel(node))
    const statusLbl = node.status ? escapeHtml(node.status) : ''
    const subtitle = statusLbl ? `${typeLbl} \u00b7 ${statusLbl}` : typeLbl

    // Build HTML-like label with a table for rounded appearance
    const penwidth = isFocus ? 3 : 1
    const borderColor = isFocus ? (dark ? '#f5f5f5' : '#1a1a1a') : color

    const label = [
      '<<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="6">',
      `<TR><TD><FONT POINT-SIZE="12" COLOR="${fc}"><B>${title}</B></FONT></TD></TR>`,
      `<TR><TD><FONT POINT-SIZE="9" COLOR="${fc}80">${subtitle}</FONT></TD></TR>`,
      '</TABLE>>',
    ].join('')

    lines.push(
      `  "${escapeDot(node.id)}" [` +
        `label=${label} ` +
        `fillcolor="${color}" ` +
        `color="${borderColor}" ` +
        `penwidth=${penwidth} ` +
        `shape="box" ` +
        `style="filled,rounded" ` +
        `URL="/memories/${escapeDot(node.id)}" ` +
        `tooltip="${escapeDot(truncate(node.title, 60))}"` +
        ']'
    )
  }

  lines.push('')

  // Edges
  for (const edge of edges) {
    const label = RELATION_LABELS[edge.relation_type] || edge.relation_type
    lines.push(
      `  "${escapeDot(edge.source)}" -> "${escapeDot(edge.target)}" [` +
        `label="${escapeDot(label)}" ` +
        `tooltip="${escapeDot(label)}"` +
        ']'
    )
  }

  lines.push('}')

  return lines.join('\n')
}

/**
 * Detect the current UI theme from DOM attributes and media queries.
 * Returns 'dark' or 'light'.
 */
export function detectTheme(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'dark'

  const explicit = document.documentElement.getAttribute('data-theme')
  if (explicit === 'dark') return 'dark'
  if (explicit === 'light') return 'light'

  // Fall back to OS preference
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }

  return 'light'
}
