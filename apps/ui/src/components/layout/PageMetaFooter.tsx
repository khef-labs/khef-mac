import { Fragment } from 'preact'
import type { VNode } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useLocation } from 'wouter-preact'
import { Code2, Copy, Check } from 'lucide-preact'
import { getRootVNode, getVNodeChildren } from '../../lib/pageMeta'
import { usePageMeta } from './PageMeta'
import styles from './PageMetaFooter.module.css'

const MAX_TREE_DEPTH = 16
const MAX_TREE_NODES = 300
const MIN_PANEL_HEIGHT = 120
const DEFAULT_PANEL_HEIGHT = 280

function vnodeName(node: VNode): string {
  if (typeof node.type === 'function') {
    return node.type.displayName || node.type.name || ''
  }
  return ''
}

/** True for named function components worth showing in the tree. */
function isVisibleComponent(node: VNode): boolean {
  if (typeof node.type !== 'function') return false
  if (node.type === Fragment) return false
  if ((node.type as any).__c) return false
  const name = vnodeName(node)
  if (name.length <= 2 || name === 'Anonymous') return false
  // Skip icon components: lucide base Icon and any *Icon named components
  if (name === 'Icon' || name.endsWith('Icon')) return false
  // Skip lucide icon wrappers: components whose only function child is Icon
  const children = getVNodeChildren(node)
  const fnChildren = children.filter(
    (c): c is VNode => c != null && typeof (c as VNode).type === 'function'
  )
  if (fnChildren.length === 1 && vnodeName(fnChildren[0]) === 'Icon') return false
  return true
}

function labelForComponent(node: VNode): string {
  if (typeof node.type === 'function') {
    return node.type.displayName || node.type.name || ''
  }
  return ''
}

function formatComponentTree(root: VNode | null): string {
  if (!root) return 'No component tree available.'

  const lines: string[] = []
  let count = 0

  const walk = (node: VNode | null, depth: number) => {
    if (!node || count >= MAX_TREE_NODES || depth > MAX_TREE_DEPTH) return
    // Skip the inspector's own subtree
    if (vnodeName(node) === 'PageMetaFooter') return

    const show = isVisibleComponent(node)
    if (show) {
      count += 1
      lines.push(`${'  '.repeat(depth)}${labelForComponent(node)}`)
    }

    const children = getVNodeChildren(node)
    for (const child of children) {
      if (child == null) continue
      walk(child, show ? depth + 1 : depth)
      if (count >= MAX_TREE_NODES) break
    }
  }

  walk(root, 0)

  if (count >= MAX_TREE_NODES) {
    lines.push('...')
  }

  return lines.length > 0 ? lines.join('\n') : 'No components found.'
}

/** Extract relative path from __source.fileName (strip up to /src/). */
function cleanSourcePath(fileName: string): string {
  const idx = fileName.indexOf('/src/')
  if (idx !== -1) return fileName.slice(idx + 1)
  return fileName
}

/** Walk VNode tree and collect unique source file paths from __source. */
function collectSourceFiles(root: VNode | null): string[] {
  if (!root) return []
  const files = new Set<string>()

  const walk = (node: VNode | null) => {
    if (!node) return
    const source = (node as any).__source
    if (source?.fileName) {
      const clean = cleanSourcePath(source.fileName)
      // Only include project source files, not library code
      if (clean.startsWith('src/')) files.add(clean)
    }
    const children = getVNodeChildren(node)
    for (const child of children) {
      if (child != null) walk(child)
    }
  }

  walk(root)
  return [...files].sort()
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [text])

  return (
    <button
      type="button"
      class={styles.copyButton}
      onClick={handleCopy}
      title="Copy to clipboard"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

export function PageMetaFooter() {
  const [location] = useLocation()
  const { meta } = usePageMeta()
  const [isOpen, setIsOpen] = useState(false)
  const [treeText, setTreeText] = useState('')
  const [sourceFiles, setSourceFiles] = useState<string[]>([])
  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT)
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)

  const sourceFilesText = useMemo(() => sourceFiles.join('\n'), [sourceFiles])

  useEffect(() => {
    if (!isOpen) return
    const root = getRootVNode()
    setTreeText(formatComponentTree(root))
    setSourceFiles(collectSourceFiles(root))
  }, [isOpen, location, meta.label])

  const handleDragStart = useCallback((e: PointerEvent) => {
    const panel = panelRef.current
    if (!panel) return
    dragRef.current = { startY: e.clientY, startHeight: panel.offsetHeight }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    document.body.style.userSelect = 'none'
  }, [])

  const handleDragMove = useCallback((e: PointerEvent) => {
    const drag = dragRef.current
    const panel = panelRef.current
    if (!drag || !panel) return
    const delta = drag.startY - e.clientY
    const maxH = window.innerHeight * 0.85
    const next = Math.min(Math.max(drag.startHeight + delta, MIN_PANEL_HEIGHT), maxH)
    panel.style.height = `${next}px`
  }, [])

  const handleDragEnd = useCallback(() => {
    if (panelRef.current) {
      setPanelHeight(panelRef.current.offsetHeight)
    }
    dragRef.current = null
    document.body.style.userSelect = ''
  }, [])

  return (
    <div class={styles.footer} data-testid="page-meta-footer">
      {isOpen && (
        <>
          <div
            class={styles.dragHandle}
            onPointerDown={handleDragStart}
            onPointerMove={handleDragMove}
            onPointerUp={handleDragEnd}
            onLostPointerCapture={handleDragEnd}
          >
            <div class={styles.grip} />
          </div>
          <div
            ref={panelRef}
            class={styles.panel}
            style={{ height: `${panelHeight}px` }}
          >
            <div class={styles.metaGrid} data-testid="page-meta-footer--meta-grid">
              <div class={styles.metaRow}>
                <span class={styles.metaLabel}>Route</span>
                <span class={styles.metaValue} data-testid="page-meta-footer--route">{location}</span>
                <CopyButton text={meta.templateFiles[0] || location} />
              </div>
              <div class={styles.metaRow}>
                <span class={styles.metaLabel}>View</span>
                <span class={styles.metaValue} data-testid="page-meta-footer--view">{meta.label || 'Unknown'}</span>
                <CopyButton text={meta.templateFiles[0] || meta.label || 'Unknown'} />
              </div>
            </div>

            <div class={styles.columns}>
              <div class={styles.column}>
                <div class={styles.sectionHeader}>
                  <span class={styles.sectionTitle}>Source Files</span>
                  {sourceFiles.length > 0 && <CopyButton text={sourceFilesText} />}
                </div>
                {sourceFiles.length === 0 ? (
                  <div class={styles.empty}>No source info available.</div>
                ) : (
                  <div class={styles.codeBlock} data-testid="page-meta-footer--source-files">
                    {sourceFiles.join('\n')}
                  </div>
                )}
              </div>

              <div class={styles.column}>
                <div class={styles.sectionHeader}>
                  <span class={styles.sectionTitle}>Component Tree</span>
                  {treeText && <CopyButton text={treeText} />}
                </div>
                <div class={styles.codeBlock} data-testid="page-meta-footer--component-tree">{treeText}</div>
              </div>
            </div>
          </div>
        </>
      )}
      <div class={styles.bar}>
        <button
          type="button"
          class={styles.toggleButton}
          onClick={() => setIsOpen((v) => !v)}
          title="Page meta"
          data-testid="page-meta-footer--toggle"
        >
          <Code2 size={14} />
        </button>
      </div>
    </div>
  )
}
