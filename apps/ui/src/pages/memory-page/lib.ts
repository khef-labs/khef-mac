import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeHighlight from 'rehype-highlight'
import rehypeSlug from 'rehype-slug'
import rehypeStringify from 'rehype-stringify'
import GithubSlugger from 'github-slugger'
import { htmlSanitizeSchema, rehypeSanitize } from '../../lib/markdown'
import { previewDiagram, type DiagramType } from '../../lib/api'
import type { DiagramTheme } from '../../lib/exportPreferences'

export const STATUS_FALLBACK: Record<string, string[]> = {
  'user-todo': ['open', 'in_progress', 'done', 'blocked', 'canceled'],
  'assistant-todo': ['open', 'in_progress', 'done', 'blocked', 'canceled'],
  'user-note': ['transient', 'persistent'],
  'assistant-note': ['transient', 'persistent'],
  'project-note': ['transient', 'persistent'],
  decision: ['proposed', 'accepted', 'rejected', 'superseded'],
  pattern: ['proposed', 'active', 'deprecated'],
  context: ['current', 'updated', 'outdated'],
  commands: ['unverified', 'verified', 'deprecated'],
  reference: ['active', 'outdated', 'broken'],
  'assistant-rule': ['active', 'deprecated', 'inactive'],
  api: ['draft', 'stable', 'deprecated'],
  diagram: ['draft', 'published', 'archived'],
  csv: ['draft', 'published', 'archived'],
  video: ['unwatched', 'watched'],
  canvas: ['draft', 'published', 'archived'],
  knowledge: ['current', 'deprecated'],
}

export const CANVAS_TYPES = new Set(['canvas', 'widget', 'animation', 'prototype', 'quiz'])

const LOADING_MESSAGES = [
  'Flibgittering...',
  'Pondering the cosmos...',
  'Rummaging through neurons...',
  'Consulting the oracle...',
  'Unscrambling thoughts...',
  'Wrangling bits...',
  'Tickling the database...',
  'Herding electrons...',
  'Summoning memories...',
  'Dusting off the archives...',
  'Percolating...',
  'Cogitating furiously...',
  'Befuddling the cache...',
  'Untangling synapses...',
  'Communing with silicon...',
  'Prestidigitating...',
  'Aligning the stars...',
  'Decoding the matrix...',
  'Exploring the labyrinth...',
  'Navigating the data seas...',
  'Illuminating the dark corners...',
]

export function getRandomLoadingMessage(): string {
  return LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)]
}

export function formatDate(dateString: string): string {
  const date = new Date(dateString)
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const UUID_PATTERN = UUID_REGEX

export function isUuid(value: string): boolean {
  return UUID_REGEX.test(value)
}

export function isGoogleDocType(memory: { type: string; parent_type?: string | null }): boolean {
  return memory.type === 'google-doc' || memory.parent_type === 'google-doc'
}

interface ExternalSource {
  type: string
  id: string
  url: string
  lastSyncedAt: string
}

export function getExternalSource(metadata?: Record<string, string>): ExternalSource | null {
  if (!metadata) return null
  const type = metadata['external-source-type']
  const id = metadata['external-source-id']
  const url = metadata['external-source-url']
  const lastSyncedAt = metadata['external-source-last-synced-at']
  if (!type || !url) return null
  return { type, id: id || '', url, lastSyncedAt: lastSyncedAt || '' }
}

export function parseExternalUrl(url: string): { type: string; id: string | null; url: string } | null {
  const trimmed = url.trim()
  if (!trimmed) return null

  const googleDocMatch = trimmed.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/)
  if (googleDocMatch) {
    const docId = googleDocMatch[1]
    return {
      type: 'google-doc',
      id: docId,
      url: `https://docs.google.com/document/d/${docId}/edit`,
    }
  }

  try {
    const parsed = new URL(trimmed)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null
    }
    return {
      type: 'external-link',
      id: null,
      url: trimmed,
    }
  } catch {
    return null
  }
}

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, htmlSanitizeSchema)
  .use(rehypeHighlight)
  .use(rehypeSlug)
  .use(rehypeStringify)

const markdownProcessorWithBreaks = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, htmlSanitizeSchema)
  .use(rehypeHighlight)
  .use(rehypeSlug)
  .use(rehypeStringify)

export const MERMAID_WRAPPER_CLASS = 'mermaid-diagram'

const DIAGRAM_LANGUAGES: { regex: RegExp; type: DiagramType }[] = [
  { regex: /<pre><code class="[^"]*language-mermaid[^"]*">([\s\S]*?)<\/code><\/pre>/g, type: 'mermaid' },
  { regex: /<pre><code class="[^"]*language-d2[^"]*">([\s\S]*?)<\/code><\/pre>/g, type: 'd2' },
  { regex: /<pre><code class="[^"]*language-plantuml[^"]*">([\s\S]*?)<\/code><\/pre>/g, type: 'plantuml' },
  { regex: /<pre><code class="[^"]*language-graphviz[^"]*">([\s\S]*?)<\/code><\/pre>/g, type: 'graphviz' },
]

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;|&#60;|&#x3[Cc];/g, '<')
    .replace(/&gt;|&#62;|&#x3[Ee];/g, '>')
    .replace(/&amp;|&#38;|&#x26;/g, '&')
    .replace(/&quot;|&#34;|&#x22;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
}

async function renderDiagramBlocks(html: string, theme: DiagramTheme, maxWidth?: number): Promise<string> {
  let result = html

  for (const { regex, type } of DIAGRAM_LANGUAGES) {
    // Reset regex lastIndex since we reuse the object
    regex.lastIndex = 0
    const matches = [...result.matchAll(regex)]
    if (matches.length === 0) continue

    for (const match of matches) {
      const fullMatch = match[0]
      const chartCode = decodeHtmlEntities(match[1])

      try {
        const { svg } = await previewDiagram(type, chartCode, theme, maxWidth)
        const wrapper = `<div class="${MERMAID_WRAPPER_CLASS}" data-theme="${theme}">${svg}</div>`
        result = result.replace(fullMatch, wrapper)
      } catch (err) {
        console.error(`${type} render error:`, err)
      }
    }
  }

  return result
}

export function extractVideoUrl(content: string): string | null {
  const firstLine = content.split('\n')[0].trim()
  if (firstLine.startsWith('/api/') || /^https?:\/\//.test(firstLine)) {
    return firstLine
  }
  const match = content.match(/<video[^>]+src=["']([^"']+)["']/)
  return match?.[1] || null
}

export function stripVideoFromContent(content: string): string {
  const firstLine = content.split('\n')[0].trim()
  let result = content
  if (firstLine.startsWith('/api/') || /^https?:\/\//.test(firstLine)) {
    result = result.split('\n').slice(1).join('\n')
  }
  result = result.replace(/<video[^>]*>[\s\S]*?<\/video>/gi, '').replace(/<video[^>]*\/>/gi, '')
  return result.trim()
}

function wrapJsonContent(content: string): string {
  const trimmed = content.trim()
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmed)
      return '```json\n' + JSON.stringify(parsed, null, 2) + '\n```'
    } catch {
      // Not valid JSON, return as-is.
    }
  }
  return content
}

export async function renderMarkdown(content: string, theme: DiagramTheme, maxWidth?: number, useBreaks = false): Promise<string> {
  const processor = useBreaks ? markdownProcessorWithBreaks : markdownProcessor
  const file = await processor.process(wrapJsonContent(content))
  const html = String(file)
  return renderDiagramBlocks(html, theme, maxWidth)
}

export interface TocItem {
  id: string
  text: string
  depth: number
}

function getNodeText(node: any): string {
  if (!node) return ''
  if (node.type === 'text' || node.type === 'inlineCode') return node.value || ''
  if (node.type === 'image' || node.type === 'imageReference') return node.alt || ''
  if (!node.children) return ''
  let result = ''
  for (const child of node.children) {
    result += getNodeText(child)
  }
  return result
}

export function buildToc(content: string): TocItem[] {
  if (!content) return []
  let tree: any
  try {
    tree = unified().use(remarkParse).use(remarkGfm).parse(content)
  } catch {
    return []
  }

  const slugger = new GithubSlugger()
  const items: TocItem[] = []

  const visit = (node: any) => {
    if (node?.type === 'heading' && typeof node.depth === 'number' && node.depth <= 3) {
      const text = getNodeText(node).trim()
      if (text) {
        items.push({
          id: slugger.slug(text),
          text,
          depth: node.depth,
        })
      }
    }
    if (node?.children && Array.isArray(node.children)) {
      for (const child of node.children) visit(child)
    }
  }

  visit(tree)
  return items
}

export interface HeadingPosition {
  line: number
  slug: string
}

/**
 * Fast line-by-line scan for markdown headings with their line numbers.
 * Uses GithubSlugger to produce slugs consistent with buildToc/rehype-slug.
 */
export function buildHeadingPositions(content: string): HeadingPosition[] {
  if (!content) return []
  const slugger = new GithubSlugger()
  const positions: HeadingPosition[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,3})\s+(.+)/)
    if (match) {
      positions.push({ line: i + 1, slug: slugger.slug(match[2].trim()) })
    }
  }
  return positions
}
