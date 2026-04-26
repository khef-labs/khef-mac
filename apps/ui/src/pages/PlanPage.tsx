import { useState, useEffect, useRef } from 'preact/hooks'
import { Link, useLocation } from 'wouter-preact'
import { FileText, Copy, Check, Download, Trash2, Pencil, User, Bot, MessageCircle, ChevronRight as ChevronRightIcon, ChevronDown, MessageSquareText, FileDown, Send, RotateCcw } from 'lucide-preact'
import clsx from 'clsx'
import { getPlan, deletePlan, deletePlanVersion, previewDiagram, getPlanVersions, getPlanVersion, createPlanComment, exportPlan, type DiagramType } from '../lib/api'
import { markdownProcessor } from '../lib/markdown'
import type { Plan, PlanVersion } from '../types'
import { getDiagramTheme, type DiagramTheme } from '../lib/exportPreferences'
import { useComments } from '../hooks/useComments'
import { ConfirmModal, CopyButton, useToast } from '../components/ui'
import { useDocumentTitle } from '../hooks'
import styles from './PlanPage.module.css'

interface Props {
  handle: string
  filename: string
  projectId?: string // For navigation back to project
}

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

async function renderDiagramBlocks(html: string, theme: DiagramTheme): Promise<string> {
  let result = html

  for (const { regex, type } of DIAGRAM_LANGUAGES) {
    regex.lastIndex = 0
    const matches = [...result.matchAll(regex)]
    if (matches.length === 0) continue

    for (const match of matches) {
      const fullMatch = match[0]
      const chartCode = decodeHtmlEntities(match[1])

      try {
        const { svg } = await previewDiagram(type, chartCode, theme)
        result = result.replace(fullMatch, `<div class="mermaid-diagram" data-theme="${theme}">${svg}</div>`)
      } catch {
        // Keep original on error
      }
    }
  }

  return result
}

async function renderMarkdown(content: string, theme: DiagramTheme): Promise<string> {
  const file = await markdownProcessor.process(content)
  const html = String(file)
  return renderDiagramBlocks(html, theme)
}

function formatDate(dateString: string): string {
  const date = new Date(dateString)
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function PlanPage({ handle, filename, projectId }: Props) {
  const [, setLocation] = useLocation()
  const { showToast } = useToast()
  const [plan, setPlan] = useState<Plan | null>(null)
  const [renderedContent, setRenderedContent] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedMarkdown, setCopiedMarkdown] = useState(false)
  const [copiedSlack, setCopiedSlack] = useState(false)
  const [copiedCommentId, setCopiedCommentId] = useState<string | null>(null)
  const [copiedCommentText, setCopiedCommentText] = useState<string | null>(null)
  const [deleteMode, setDeleteMode] = useState<'version' | 'plan' | null>(null)
  const [showDeleteMenu, setShowDeleteMenu] = useState(false)
  const [versions, setVersions] = useState<PlanVersion[]>([])
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null)
  const [showVersionMenu, setShowVersionMenu] = useState(false)
  const [floatingButtonPos, setFloatingButtonPos] = useState<{ x: number; y: number } | null>(null)
  const [inlineCommentPos, setInlineCommentPos] = useState<{ x: number; y: number } | null>(null)
  const inlineCommentOpenRef = useRef(false)
  const [inlineCommentInput, setInlineCommentInput] = useState('')
  const [isSubmittingInline, setIsSubmittingInline] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  useDocumentTitle(plan?.title ? `Plan - ${plan.title}` : 'Plan - Loading')

  // Comments hook for plan comments (uses plan UUID)
  const commentsHook = useComments({
    entityType: 'plan',
    planId: plan?.id || '',
    rawContent: plan?.content || '',
    contentRef,
    renderedContent,
  })

  useEffect(() => {
    async function load() {
      setIsLoading(true)
      setError(null)
      try {
        const [p, v] = await Promise.all([
          getPlan(handle, filename),
          getPlanVersions(handle, filename),
        ])
        setPlan(p)
        setVersions(v)
        setSelectedVersion(p.current_version)
        const theme = getDiagramTheme()
        const html = await renderMarkdown(p.content, theme)
        setRenderedContent(html)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load plan')
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [handle, filename])

  const handleCopy = async () => {
    if (!plan) return
    try {
      await navigator.clipboard.writeText(plan.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API failed
    }
  }

  const handleCopyMarkdown = async () => {
    if (!plan) return
    try {
      const result = await exportPlan(plan.id, 'markdown')
      if ('text' in result) {
        await navigator.clipboard.writeText(result.text)
        setCopiedMarkdown(true)
        setTimeout(() => setCopiedMarkdown(false), 2000)
      }
    } catch (err) {
      console.error('Markdown copy failed:', err)
    }
  }

  const handleCopySlack = async () => {
    if (!plan) return
    try {
      const result = await exportPlan(plan.id, 'slack')
      if ('text' in result) {
        await navigator.clipboard.writeText(result.text)
        setCopiedSlack(true)
        setTimeout(() => setCopiedSlack(false), 2000)
      }
    } catch (err) {
      console.error('Slack copy failed:', err)
    }
  }

  const copyCommentId = async (commentId: string) => {
    try {
      await navigator.clipboard.writeText(commentId)
      setCopiedCommentId(commentId)
      setTimeout(() => {
        setCopiedCommentId((prev) => (prev === commentId ? null : prev))
      }, 2000)
    } catch (err) {
      console.error('Failed to copy comment ID:', err)
      showToast('Copy failed')
    }
  }

  const copyCommentText = async (commentId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedCommentText(commentId)
      setTimeout(() => {
        setCopiedCommentText((prev) => (prev === commentId ? null : prev))
      }, 2000)
    } catch (err) {
      console.error('Failed to copy comment text:', err)
      showToast('Copy failed')
    }
  }

  const handleExportMarkdown = () => {
    if (!plan) return
    const blob = new Blob([plan.content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${plan.filename.replace(/\.md$/, '')}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const handleExportDocx = async () => {
    if (!plan) return
    try {
      const result = await exportPlan(plan.id, 'docx')
      if ('blob' in result) {
        const url = URL.createObjectURL(result.blob)
        const a = document.createElement('a')
        a.href = url
        const filename = plan.filename.replace(/\.md$/, '')
        a.download = `${filename}.docx`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      console.error('DOCX export failed:', err)
    }
  }

  const handleDelete = async () => {
    if (!plan || !selectedVersion) return
    try {
      if (deleteMode === 'plan') {
        await deletePlan(handle, filename)
        showToast('Plan deleted')
        setLocation(projectId ? `/projects/${projectId}/plans` : `/assistants/${handle}/plans`)
      } else if (deleteMode === 'version') {
        await deletePlanVersion(handle, filename, selectedVersion)
        showToast(`Version ${selectedVersion} deleted`)
        // Reload versions and switch to current if we deleted the viewed version
        const newVersions = await getPlanVersions(handle, filename)
        if (newVersions.length === 0) {
          // All versions deleted, plan is gone
          setLocation(projectId ? `/projects/${projectId}/plans` : `/assistants/${handle}/plans`)
        } else {
          setVersions(newVersions)
          // If we deleted the version we were viewing, switch to current
          if (selectedVersion === plan.current_version || !newVersions.find(v => v.version === selectedVersion)) {
            const p = await getPlan(handle, filename)
            setPlan(p)
            setSelectedVersion(p.current_version)
            const theme = getDiagramTheme()
            const html = await renderMarkdown(p.content, theme)
            setRenderedContent(html)
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    } finally {
      setDeleteMode(null)
    }
  }

  const handleVersionSelect = async (version: number) => {
    if (!plan) return
    setShowVersionMenu(false)
    if (version === plan.current_version) {
      // Current version - use existing plan content
      setSelectedVersion(version)
      const theme = getDiagramTheme()
      const html = await renderMarkdown(plan.content, theme)
      setRenderedContent(html)
    } else {
      // Historical version - fetch from API
      try {
        const v = await getPlanVersion(handle, filename, version)
        setSelectedVersion(version)
        const theme = getDiagramTheme()
        const html = await renderMarkdown(v.content || '', theme)
        setRenderedContent(html)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load version')
      }
    }
  }

  // Close version menu on outside click
  useEffect(() => {
    if (!showVersionMenu) return
    const handleClick = () => setShowVersionMenu(false)
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [showVersionMenu])

  // Close delete menu on outside click
  useEffect(() => {
    if (!showDeleteMenu) return
    const handleClick = () => setShowDeleteMenu(false)
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [showDeleteMenu])

  // Floating comment button on text selection
  useEffect(() => {
    if (isLoading) {
      setFloatingButtonPos(null)
      return
    }
    const container = contentRef.current
    if (!container) return

    const handleMouseUp = () => {
      requestAnimationFrame(() => {
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || !container.contains(sel.anchorNode)) {
          setFloatingButtonPos(null)
          return
        }
        const range = sel.getRangeAt(0)
        const rect = range.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()
        setFloatingButtonPos({
          x: rect.left - containerRect.left + rect.width / 2,
          y: rect.top - containerRect.top - 8,
        })
      })
    }

    const handleMouseDownOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('[class*="floatingCommentButton"]')) {
        setFloatingButtonPos(null)
      }
      if (!target.closest('[class*="inlineCommentBox"]')) {
        if (inlineCommentOpenRef.current) {
          setInlineCommentPos(null)
          inlineCommentOpenRef.current = false
          commentsHook.clearAnchor()
        }
      }
    }

    container.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('mousedown', handleMouseDownOutside)
    return () => {
      container.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('mousedown', handleMouseDownOutside)
    }
  }, [isLoading, commentsHook])

  // Handle inline comment submission
  const handleInlineCommentSubmit = async () => {
    const content = inlineCommentInput.trim()
    if (!content || !plan?.id) return

    setIsSubmittingInline(true)
    try {
      await createPlanComment(plan.id, {
        content,
        anchor_text: commentsHook.pendingAnchor?.anchor_text,
        anchor_prefix: commentsHook.pendingAnchor?.anchor_prefix,
        anchor_suffix: commentsHook.pendingAnchor?.anchor_suffix,
      })
      setInlineCommentInput('')
      setInlineCommentPos(null)
      inlineCommentOpenRef.current = false
      commentsHook.clearAnchor()
      commentsHook.fetchComments()
    } catch (err) {
      console.error('Failed to create comment', err)
    } finally {
      setIsSubmittingInline(false)
    }
  }

  // Alt+C to capture selection and open inline comment box
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Alt+C to open inline comment (use event.code because Alt+C produces 'ç' on macOS)
      if (event.altKey && event.code === 'KeyC' && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        const sel = window.getSelection()
        if (sel && !sel.isCollapsed && contentRef.current?.contains(sel.anchorNode)) {
          const range = sel.getRangeAt(0)
          const rect = range.getBoundingClientRect()
          const containerRect = contentRef.current.getBoundingClientRect()
          const pos = {
            x: rect.left - containerRect.left + rect.width / 2,
            y: rect.bottom - containerRect.top,
          }
          commentsHook.captureSelection()
          setFloatingButtonPos(null)
          setInlineCommentPos(pos)
          inlineCommentOpenRef.current = true
          setInlineCommentInput('')
          requestAnimationFrame(() => {
            const inlineTextarea = document.querySelector<HTMLTextAreaElement>('[data-inline-comment-input]')
            inlineTextarea?.focus()
          })
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [commentsHook])

  if (isLoading) {
    return (
      <div class={styles.page}>
        <div class={styles.loading}>Loading plan...</div>
      </div>
    )
  }

  const backLink = projectId
    ? `/projects/${projectId}/plans`
    : `/assistants/${handle}/plans`

  if (error || !plan) {
    return (
      <div class={styles.page}>
        <div class={styles.error}>{error || 'Plan not found'}</div>
        <Link href={backLink}>Plans</Link>
      </div>
    )
  }

  return (
    <div class={styles.page}>
      {/* Top navigation bar */}
      <div class={styles.topNav}>
        <div class={styles.exportButtons}>
          <div class={styles.exportMenuContainer}>
            <button class={styles.exportButton} onClick={handleCopy} title="Copy content to clipboard">
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <div class={styles.exportMenuOptions}>
              <button class={styles.exportOption} onClick={handleCopyMarkdown} title="Copy as Markdown with frontmatter">
                {copiedMarkdown ? <Check size={14} /> : <FileText size={14} />}
                {copiedMarkdown ? 'Copied' : 'Markdown'}
              </button>
              <button class={styles.exportOption} onClick={handleCopySlack} title="Copy as Slack message">
                {copiedSlack ? <Check size={14} /> : <MessageSquareText size={14} />}
                {copiedSlack ? 'Copied' : 'Slack'}
              </button>
            </div>
          </div>

          <div class={styles.exportMenuContainer}>
            <button class={styles.exportButton} onClick={handleExportMarkdown} title="Export as Markdown">
              <Download size={16} />
              Export
            </button>
            <div class={styles.exportMenuOptions}>
              <button class={styles.exportOption} onClick={handleExportMarkdown} title="Download as Markdown">
                <FileText size={14} />
                Markdown
              </button>
              <button class={styles.exportOption} onClick={handleExportDocx} title="Download as Word document">
                <FileDown size={14} />
                DOCX
              </button>
            </div>
          </div>

          <div class={styles.deleteDropdown}>
            <button
              class={styles.deleteButton}
              onClick={(e) => {
                e.stopPropagation()
                setShowDeleteMenu((prev) => !prev)
              }}
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
            {showDeleteMenu && (
              <div class={styles.deleteMenu}>
                <button
                  class={styles.deleteMenuItem}
                  onClick={() => {
                    setShowDeleteMenu(false)
                    setDeleteMode('version')
                  }}
                >
                  Delete version {selectedVersion}
                </button>
                <button
                  class={clsx(styles.deleteMenuItem, styles.deleteMenuItemDanger)}
                  onClick={() => {
                    setShowDeleteMenu(false)
                    setDeleteMode('plan')
                  }}
                >
                  Delete entire plan
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Header with title */}
      <div class={styles.header}>
        <h1 class={styles.title}>{plan.title}</h1>
        {plan.file_path && (
          <span class={styles.filePath}>
            {plan.file_path}
            <CopyButton text={plan.file_path} title="Copy full path" size={13} />
          </span>
        )}
      </div>

      {/* Metadata bar */}
      <div class={styles.metadataBar}>
        <div class={styles.metaItem}>
          <span class={styles.metaLabel}>File</span>
          <span class={styles.metaValue}>{plan.filename}</span>
        </div>
        <div class={styles.metaItem}>
          <span class={styles.metaLabel}>Version</span>
          {versions.length > 1 ? (
            <div class={styles.versionDropdown}>
              <button
                class={clsx(styles.versionBtn, selectedVersion !== plan.current_version && styles.versionOld)}
                onClick={(e) => {
                  e.stopPropagation()
                  setShowVersionMenu((prev) => !prev)
                }}
              >
                v{selectedVersion}
                {selectedVersion !== plan.current_version && ' (old)'}
                <ChevronRightIcon size={14} class={clsx(styles.versionChevron, showVersionMenu && styles.open)} />
              </button>
              {showVersionMenu && (
                <div class={styles.versionMenu}>
                  {versions.map((v) => (
                    <button
                      key={v.version}
                      class={clsx(styles.versionMenuItem, v.version === selectedVersion && styles.selected)}
                      onClick={() => handleVersionSelect(v.version)}
                    >
                      <span>v{v.version}</span>
                      {v.version === plan.current_version && <span class={styles.currentBadge}>current</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <span class={styles.metaValue}>v{plan.current_version}</span>
          )}
        </div>
        <div class={styles.metaItem}>
          <span class={styles.metaLabel}>ID</span>
          <span class={styles.metaValueWithAction}>
            <span class={styles.metaValue} title={plan.id}>{plan.id.slice(0, 8)}…</span>
            <CopyButton text={plan.id} size={12} title="Copy ID" />
          </span>
        </div>
        <div class={styles.metaItem}>
          <span class={styles.metaLabel}>Updated</span>
          <span class={styles.metaValue}>{formatDate(plan.updated_at)}</span>
        </div>
        <div class={styles.metaItem}>
          <span class={styles.metaLabel}>Size</span>
          <span class={styles.metaValue}>{formatSize(plan.size)}</span>
        </div>
      </div>

      <div class={styles.contentWrapper}>
        <article
          ref={contentRef}
          class={styles.content}
          dangerouslySetInnerHTML={{ __html: renderedContent }}
        />

        {/* Floating comment button on text selection */}
        {floatingButtonPos && !inlineCommentPos && (
          <button
            class={styles.floatingCommentButton}
            style={{
              left: `${floatingButtonPos.x}px`,
              top: `${floatingButtonPos.y}px`,
            }}
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              const sel = window.getSelection()
              let posX = floatingButtonPos.x
              let posY = floatingButtonPos.y + 40
              if (sel && !sel.isCollapsed && contentRef.current) {
                const range = sel.getRangeAt(0)
                const rect = range.getBoundingClientRect()
                const containerRect = contentRef.current.getBoundingClientRect()
                posX = rect.left - containerRect.left + rect.width / 2
                posY = rect.bottom - containerRect.top + 4
              }
              commentsHook.captureSelection()
              setInlineCommentPos({ x: posX, y: posY })
              inlineCommentOpenRef.current = true
              setInlineCommentInput('')
              setFloatingButtonPos(null)
              requestAnimationFrame(() => {
                const inlineTextarea = document.querySelector<HTMLTextAreaElement>('[data-inline-comment-input]')
                inlineTextarea?.focus()
              })
            }}
            title="Comment on selection (Alt+C)"
          >
            <MessageSquareText size={14} />
          </button>
        )}

        {/* Inline comment box at selection */}
        {inlineCommentPos && (
          <div
            class={styles.inlineCommentBox}
            style={{
              left: `${Math.max(0, inlineCommentPos.x - 150)}px`,
              top: `${inlineCommentPos.y + 8}px`,
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {commentsHook.pendingAnchor && (
              <div class={styles.inlineAnchorPreview}>
                &ldquo;{commentsHook.pendingAnchor.anchor_text!.length > 40
                  ? commentsHook.pendingAnchor.anchor_text!.slice(0, 40) + '...'
                  : commentsHook.pendingAnchor.anchor_text}&rdquo;
              </div>
            )}
            <textarea
              class={styles.inlineCommentTextarea}
              placeholder="Add a comment..."
              value={inlineCommentInput}
              onInput={(e) => setInlineCommentInput((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                  e.preventDefault()
                  handleInlineCommentSubmit()
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setInlineCommentPos(null)
                  inlineCommentOpenRef.current = false
                  setInlineCommentInput('')
                  commentsHook.clearAnchor()
                }
              }}
              data-inline-comment-input
            />
            <div class={styles.inlineCommentActions}>
              <button
                class={styles.cancelButton}
                onClick={() => {
                  setInlineCommentPos(null)
                  inlineCommentOpenRef.current = false
                  setInlineCommentInput('')
                  commentsHook.clearAnchor()
                }}
              >
                Cancel
              </button>
              <button
                class={styles.submitButton}
                onClick={handleInlineCommentSubmit}
                disabled={isSubmittingInline || !inlineCommentInput.trim()}
                title="Submit (Cmd+S)"
              >
                {isSubmittingInline ? 'Posting...' : 'Post'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Comments Section */}
      <div class={styles.commentsSection}>
        <div class={styles.commentsHeader}>
          <h2 class={styles.commentsTitle}>
            Comments
            {commentsHook.openThreads.length > 0 && (
              <span class={styles.commentCount}>{commentsHook.openThreads.length}</span>
            )}
          </h2>
        </div>

        {/* Open comment threads */}
        {commentsHook.openThreads.length > 0 ? (
          <div class={styles.commentsList}>
            {commentsHook.openThreads.map((thread) => (
              <div key={thread.id} class={styles.commentThread}>
                <div class={styles.commentItem}>
                  {commentsHook.editingCommentId === thread.id ? (
                    <div class={styles.commentEditArea}>
                      <textarea
                        class={styles.commentTextarea}
                        value={commentsHook.editingCommentContent}
                        onInput={(e) =>
                          commentsHook.setEditingCommentContent(
                            (e.target as HTMLTextAreaElement).value
                          )
                        }
                      />
                      <div class={styles.commentEditActions}>
                        <button
                          class={styles.cancelButton}
                          onClick={commentsHook.cancelEditing}
                          disabled={commentsHook.isSubmitting}
                        >
                          Cancel
                        </button>
                        <button
                          class={styles.saveButton}
                          onClick={commentsHook.saveEdit}
                          disabled={commentsHook.isSubmitting}
                        >
                          {commentsHook.isSubmitting ? 'Saving...' : 'Save'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div class={styles.commentBody}>
                        <span class={clsx(styles.commentAuthor, thread.author !== 'user' && styles.commentAuthorBot)}>
                          {thread.author === 'user' ? <User size={12} /> : <Bot size={12} />}
                          {thread.author}
                        </span>
                        {thread.anchor_text && (
                          <button
                            class={styles.commentAnchorBadge}
                            onClick={() => commentsHook.scrollToAnchor(thread)}
                            title="Click to scroll to anchored text"
                          >
                            &ldquo;{thread.anchor_text.length > 40
                              ? thread.anchor_text.slice(0, 40) + '...'
                              : thread.anchor_text}&rdquo;
                          </button>
                        )}
                        <p class={styles.commentContent}>{thread.content}</p>
                        <div class={styles.commentFooter}>
                          <span class={styles.commentTimestamp}>
                            {new Date(thread.created_at).toLocaleString()}
                          </span>
                          {/* Reply count toggle */}
                          {thread.replies.length > 0 ? (
                            <button
                              class={clsx(
                                styles.replyToggle,
                                commentsHook.isThreadExpanded(thread.id) && styles.replyToggleExpanded
                              )}
                              onClick={() => commentsHook.toggleThread(thread.id)}
                            >
                              <ChevronRightIcon size={12} />
                              {thread.replies.length} {thread.replies.length === 1 ? 'reply' : 'replies'}
                            </button>
                          ) : (
                            <button
                              class={styles.replyLink}
                              onClick={() => commentsHook.startReply(thread.id)}
                            >
                              Reply
                            </button>
                          )}
                        </div>
                      </div>
                      <div class={styles.commentActions}>
                        <button
                          class={styles.replyButton}
                          onClick={() => commentsHook.startReply(thread.id)}
                          title="Reply"
                        >
                          <MessageCircle size={12} />
                        </button>
                        <button
                          class={styles.commentActionButton}
                          onClick={() => copyCommentText(thread.id, thread.content)}
                          title={copiedCommentText === thread.id ? 'Copied!' : 'Copy text'}
                        >
                          {copiedCommentText === thread.id ? <Check size={12} /> : <FileText size={12} />}
                        </button>
                        <button
                          class={styles.commentActionButton}
                          onClick={() => copyCommentId(thread.id)}
                          title={copiedCommentId === thread.id ? 'Copied!' : 'Copy comment ID'}
                        >
                          {copiedCommentId === thread.id ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                        <button
                          class={styles.commentActionButton}
                          onClick={() => commentsHook.resolveComment(thread.id)}
                          title="Resolve comment"
                        >
                          <Check size={12} />
                        </button>
                        <button
                          class={styles.commentActionButton}
                          onClick={() => commentsHook.startEditing(thread)}
                          title="Edit comment"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          class={styles.commentActionButton}
                          onClick={() => commentsHook.removeComment(thread.id)}
                          title="Delete comment"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </>
                  )}
                </div>

                {/* Expanded replies */}
                {commentsHook.isThreadExpanded(thread.id) && thread.replies.length > 0 && (
                  <div class={styles.repliesContainer}>
                    {thread.replies.map((reply) => (
                      <div key={reply.id} class={styles.replyItem}>
                        <span class={styles.replyArrow}>↳</span>
                        <div class={styles.commentBody}>
                          <span class={clsx(styles.commentAuthor, reply.author !== 'user' && styles.commentAuthorBot)}>
                            {reply.author === 'user' ? <User size={12} /> : <Bot size={12} />}
                            {reply.author}
                          </span>
                          <p class={styles.commentContent}>{reply.content}</p>
                          <div class={styles.commentFooter}>
                            <span class={styles.commentTimestamp}>
                              {new Date(reply.created_at).toLocaleString()}
                            </span>
                            <button
                              class={styles.replyLink}
                              onClick={() => commentsHook.startReply(thread.id)}
                            >
                              Reply
                            </button>
                          </div>
                        </div>
                        <div class={styles.commentActions}>
                          <button
                            class={styles.commentActionButton}
                            onClick={() => copyCommentText(reply.id, reply.content)}
                            title={copiedCommentText === reply.id ? 'Copied!' : 'Copy text'}
                          >
                            {copiedCommentText === reply.id ? <Check size={12} /> : <FileText size={12} />}
                          </button>
                          <button
                            class={styles.commentActionButton}
                            onClick={() => copyCommentId(reply.id)}
                            title={copiedCommentId === reply.id ? 'Copied!' : 'Copy comment ID'}
                          >
                            {copiedCommentId === reply.id ? <Check size={12} /> : <Copy size={12} />}
                          </button>
                          <button
                            class={styles.commentActionButton}
                            onClick={() => commentsHook.startEditing(reply)}
                            title="Edit reply"
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            class={styles.commentActionButton}
                            onClick={() => commentsHook.removeComment(reply.id)}
                            title="Delete reply"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Reply input (shown when replying to this thread) */}
                {commentsHook.replyingToId === thread.id && (
                  <div class={styles.repliesContainer}>
                    <div class={styles.replyInputArea}>
                      <div class={styles.replyInputRow}>
                        <textarea
                          class={styles.replyTextarea}
                          placeholder="Write a reply..."
                          value={commentsHook.replyInput}
                          onInput={(e) =>
                            commentsHook.setReplyInput((e.target as HTMLTextAreaElement).value)
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault()
                              commentsHook.submitReply(thread.id)
                            }
                          }}
                          autoFocus
                        />
                        <button
                          class={styles.submitReplyButton}
                          onClick={() => commentsHook.submitReply(thread.id)}
                          disabled={commentsHook.isSubmitting || !commentsHook.replyInput.trim()}
                          title="Submit reply (Enter)"
                        >
                          <Send size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          !commentsHook.isLoading && commentsHook.resolvedThreads.length === 0 && (
            <p class={styles.emptyComments}>No comments yet</p>
          )
        )}

        {/* Resolved threads (collapsible) */}
        {commentsHook.resolvedThreads.length > 0 && (
          <div class={styles.resolvedSection}>
            <div class={styles.resolvedHeader}>
              <button
                class={styles.resolvedToggle}
                onClick={() => commentsHook.setShowResolved(!commentsHook.showResolved)}
              >
                <ChevronDown
                  size={14}
                  style={{
                    transform: commentsHook.showResolved ? 'none' : 'rotate(-90deg)',
                    transition: 'transform 0.15s',
                  }}
                />
                {commentsHook.resolvedThreads.length} resolved{' '}
                {commentsHook.resolvedThreads.length !== 1 ? 'threads' : 'thread'}
              </button>
              <button
                class={styles.deleteResolvedButton}
                onClick={() => commentsHook.deleteResolved()}
                title="Delete all resolved comments"
              >
                <Trash2 size={12} />
                Delete resolved
              </button>
            </div>
            {commentsHook.showResolved && (
              <div class={styles.commentsList}>
                {commentsHook.resolvedThreads.map((thread) => (
                  <div key={thread.id} class={styles.commentThread}>
                    <div class={clsx(styles.commentItem, styles.commentItemResolved)}>
                      <div class={styles.commentBody}>
                        <span class={clsx(styles.commentAuthor, thread.author !== 'user' && styles.commentAuthorBot)}>
                          {thread.author === 'user' ? <User size={12} /> : <Bot size={12} />}
                          {thread.author}
                        </span>
                        {thread.anchor_text && (
                          <button
                            class={styles.commentAnchorBadge}
                            onClick={() => commentsHook.scrollToAnchor(thread)}
                            title="Click to scroll to anchored text"
                          >
                            &ldquo;{thread.anchor_text.length > 40
                              ? thread.anchor_text.slice(0, 40) + '...'
                              : thread.anchor_text}&rdquo;
                          </button>
                        )}
                        <p class={styles.commentContent}>{thread.content}</p>
                        <span class={styles.commentTimestamp}>
                          {new Date(thread.created_at).toLocaleString()}
                        </span>
                        {thread.replies.length > 0 && (
                          <button
                            class={clsx(
                              styles.replyToggle,
                              commentsHook.isThreadExpanded(thread.id) && styles.replyToggleExpanded
                            )}
                            onClick={() => commentsHook.toggleThread(thread.id)}
                          >
                            <ChevronRightIcon size={12} />
                            {thread.replies.length} {thread.replies.length === 1 ? 'reply' : 'replies'}
                          </button>
                        )}
                      </div>
                      <div class={styles.commentActions}>
                        <button
                          class={styles.commentActionButton}
                          onClick={() => copyCommentText(thread.id, thread.content)}
                          title={copiedCommentText === thread.id ? 'Copied!' : 'Copy text'}
                        >
                          {copiedCommentText === thread.id ? <Check size={12} /> : <FileText size={12} />}
                        </button>
                        <button
                          class={styles.commentActionButton}
                          onClick={() => copyCommentId(thread.id)}
                          title={copiedCommentId === thread.id ? 'Copied!' : 'Copy comment ID'}
                        >
                          {copiedCommentId === thread.id ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                        <button
                          class={styles.commentActionButton}
                          onClick={() => commentsHook.reopenComment(thread.id)}
                          title="Reopen comment"
                        >
                          <RotateCcw size={12} />
                        </button>
                        <button
                          class={styles.commentActionButton}
                          onClick={() => commentsHook.removeComment(thread.id)}
                          title="Delete comment"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                    {commentsHook.isThreadExpanded(thread.id) && thread.replies.length > 0 && (
                      <div class={styles.repliesContainer}>
                        {thread.replies.map((reply) => (
                          <div key={reply.id} class={clsx(styles.replyItem, styles.commentItemResolved)}>
                            <span class={styles.replyArrow}>↳</span>
                            <div class={styles.commentBody}>
                              <span class={clsx(styles.commentAuthor, reply.author !== 'user' && styles.commentAuthorBot)}>
                                {reply.author === 'user' ? <User size={12} /> : <Bot size={12} />}
                                {reply.author}
                              </span>
                              <p class={styles.commentContent}>{reply.content}</p>
                              <span class={styles.commentTimestamp}>
                                {new Date(reply.created_at).toLocaleString()}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Orphaned threads (collapsible) */}
        {commentsHook.orphanedThreads.length > 0 && (
          <div class={styles.orphanedSection}>
            <button
              class={styles.orphanedToggle}
              onClick={() => commentsHook.setShowOrphaned(!commentsHook.showOrphaned)}
            >
              <ChevronDown
                size={14}
                style={{
                  transform: commentsHook.showOrphaned ? 'none' : 'rotate(-90deg)',
                  transition: 'transform 0.15s',
                }}
              />
              {commentsHook.orphanedThreads.length} orphaned{' '}
              {commentsHook.orphanedThreads.length !== 1 ? 'threads' : 'thread'}
            </button>
            {commentsHook.showOrphaned && (
              <div class={styles.commentsList}>
                {commentsHook.orphanedThreads.map((thread) => (
                  <div key={thread.id} class={styles.commentThread}>
                    <div class={clsx(styles.commentItem, styles.commentItemOrphaned)}>
                      <div class={styles.commentBody}>
                        <span class={clsx(styles.commentAuthor, thread.author !== 'user' && styles.commentAuthorBot)}>
                          {thread.author === 'user' ? <User size={12} /> : <Bot size={12} />}
                          {thread.author}
                        </span>
                        <p class={styles.commentContent}>{thread.content}</p>
                        {thread.anchor_text && (
                          <span class={styles.commentAnchorBadgeOrphaned}>
                            &ldquo;{thread.anchor_text.length > 40
                              ? thread.anchor_text.slice(0, 40) + '...'
                              : thread.anchor_text}&rdquo;
                          </span>
                        )}
                        <span class={styles.commentTimestamp}>
                          {new Date(thread.created_at).toLocaleString()}
                        </span>
                        {thread.replies.length > 0 && (
                          <button
                            class={clsx(
                              styles.replyToggle,
                              commentsHook.isThreadExpanded(thread.id) && styles.replyToggleExpanded
                            )}
                            onClick={() => commentsHook.toggleThread(thread.id)}
                          >
                            <ChevronRightIcon size={12} />
                            {thread.replies.length} {thread.replies.length === 1 ? 'reply' : 'replies'}
                          </button>
                        )}
                      </div>
                      <div class={styles.commentActions}>
                        <button
                          class={styles.commentActionButton}
                          onClick={() => copyCommentText(thread.id, thread.content)}
                          title={copiedCommentText === thread.id ? 'Copied!' : 'Copy text'}
                        >
                          {copiedCommentText === thread.id ? <Check size={12} /> : <FileText size={12} />}
                        </button>
                        <button
                          class={styles.commentActionButton}
                          onClick={() => copyCommentId(thread.id)}
                          title={copiedCommentId === thread.id ? 'Copied!' : 'Copy comment ID'}
                        >
                          {copiedCommentId === thread.id ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                        <button
                          class={styles.commentActionButton}
                          onClick={() => commentsHook.resolveComment(thread.id)}
                          title="Resolve"
                        >
                          <Check size={12} />
                        </button>
                        <button
                          class={styles.commentActionButton}
                          onClick={() => commentsHook.removeComment(thread.id)}
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                    {commentsHook.isThreadExpanded(thread.id) && thread.replies.length > 0 && (
                      <div class={styles.repliesContainer}>
                        {thread.replies.map((reply) => (
                          <div key={reply.id} class={clsx(styles.replyItem, styles.commentItemOrphaned)}>
                            <span class={styles.replyArrow}>↳</span>
                            <div class={styles.commentBody}>
                              <span class={clsx(styles.commentAuthor, reply.author !== 'user' && styles.commentAuthorBot)}>
                                {reply.author === 'user' ? <User size={12} /> : <Bot size={12} />}
                                {reply.author}
                              </span>
                              <p class={styles.commentContent}>{reply.content}</p>
                              <span class={styles.commentTimestamp}>
                                {new Date(reply.created_at).toLocaleString()}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Comment input area (general, non-anchored) */}
        <div class={styles.commentInputArea}>
          <div class={styles.commentInputRow}>
            <textarea
              data-comment-input
              class={styles.commentTextarea}
              placeholder="Add a comment... (select text + Alt+C to anchor)"
              value={commentsHook.commentInput}
              onInput={(e) =>
                commentsHook.setCommentInput((e.target as HTMLTextAreaElement).value)
              }
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  commentsHook.submitComment()
                }
              }}
            />
            <button
              class={styles.submitCommentButton}
              onClick={commentsHook.submitComment}
              disabled={commentsHook.isSubmitting || !commentsHook.commentInput.trim()}
              title="Submit comment (Cmd+Enter)"
            >
              <Send size={14} />
            </button>
          </div>
          {commentsHook.error && (
            <p class={styles.commentError}>{commentsHook.error}</p>
          )}
        </div>
      </div>

      {deleteMode && (
        <ConfirmModal
          title={deleteMode === 'plan' ? 'Delete Plan' : `Delete Version ${selectedVersion}`}
          message={
            deleteMode === 'plan'
              ? `Delete "${plan.title}" and all its versions? This cannot be undone.`
              : `Delete version ${selectedVersion} of "${plan.title}"? This cannot be undone.`
          }
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setDeleteMode(null)}
        />
      )}
    </div>
  )
}
