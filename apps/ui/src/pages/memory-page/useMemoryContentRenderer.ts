import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks'
import type { RefObject } from 'preact'
import {
  buildHeadingPositions,
  buildToc,
  renderMarkdown,
  stripVideoFromContent,
} from './lib'
import {
  getDiagramTheme,
  type DiagramTheme,
} from '../../lib/exportPreferences'
import { getSettings } from '../../lib/settings'
import type { Memory } from '../../types'

interface UseMemoryContentRendererOptions {
  memory: Memory | null
  isEditingContent: boolean
  editContent: string
  contentMode: 'edit' | 'preview'
  isViewingHistoricalSnapshot: boolean
  snapshotContent: string | null
  contentRef: RefObject<HTMLDivElement>
  editMaxWidth: string
}

export function useMemoryContentRenderer({
  memory,
  isEditingContent,
  editContent,
  contentMode,
  isViewingHistoricalSnapshot,
  snapshotContent,
  contentRef,
  editMaxWidth,
}: UseMemoryContentRendererOptions) {
  const [renderedContent, setRenderedContent] = useState('')
  const [renderedEditContent, setRenderedEditContent] = useState('')
  const [globalDiagramTheme, setGlobalDiagramTheme] = useState<DiagramTheme>(getDiagramTheme)
  const [activeHeadingId, setActiveHeadingId] = useState<string>('')
  const [isTocVisible, setIsTocVisible] = useState(true)
  const [editorTopLine, setEditorTopLine] = useState(1)
  const [editorCursorTarget, setEditorCursorTarget] = useState<{ line: number; col: number; token: number } | null>(null)
  const pendingScrollSlugRef = useRef<string | null>(null)
  const tocClickActiveUntilRef = useRef(0)

  // Listen for storage changes to refresh diagram theme
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'khef-export-preferences') {
        setGlobalDiagramTheme(getDiagramTheme())
      }
    }
    // Also refresh on focus (in case settings changed in another tab)
    const handleFocus = () => {
      setGlobalDiagramTheme(getDiagramTheme())
    }
    window.addEventListener('storage', handleStorage)
    window.addEventListener('focus', handleFocus)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener('focus', handleFocus)
    }
  }, [])

  // Render view-mode markdown
  useEffect(() => {
    if (!memory) return
    let isActive = true
    const maxWidth = memory.metadata?.['svg-max-width']
      ? parseInt(memory.metadata['svg-max-width'], 10)
      : getSettings().diagram.defaultMaxWidth
    // Use per-memory theme override if set, otherwise global theme
    const theme = (memory.metadata?.['export-image-theme'] as DiagramTheme) || globalDiagramTheme
    // Use displayContent (which uses snapshotContent when viewing historical version)
    let contentToRender = isViewingHistoricalSnapshot && snapshotContent !== null ? snapshotContent : memory.content
    // For video type, strip the video URL and <video> tags — rendered by VideoPlayer
    if (memory.type === 'video') {
      contentToRender = stripVideoFromContent(contentToRender)
    }
    renderMarkdown(contentToRender, theme, maxWidth)
      .then((html) => {
        if (isActive) setRenderedContent(html)
      })
      .catch(() => {
        if (isActive) setRenderedContent(contentToRender)
      })
    return () => {
      isActive = false
    }
  }, [memory, globalDiagramTheme, isViewingHistoricalSnapshot, snapshotContent])

  // Render edit-mode markdown (debounced)
  useEffect(() => {
    let isActive = true
    const maxWidth = editMaxWidth
      ? parseInt(editMaxWidth, 10)
      : memory?.metadata?.['svg-max-width']
        ? parseInt(memory.metadata['svg-max-width'], 10)
        : getSettings().diagram.defaultMaxWidth
    const theme = (memory?.metadata?.['export-image-theme'] as DiagramTheme) || globalDiagramTheme
    const timer = setTimeout(() => {
      renderMarkdown(editContent, theme, maxWidth, true)
        .then((html) => {
          if (isActive) setRenderedEditContent(html)
        })
        .catch(() => {
          if (isActive) setRenderedEditContent(editContent)
        })
    }, isEditingContent ? 300 : 0)
    return () => {
      isActive = false
      clearTimeout(timer)
    }
  }, [editContent, editMaxWidth, memory?.metadata, globalDiagramTheme, isEditingContent])

  // TOC source and items
  const tocSource = useMemo(() => {
    if (isEditingContent) {
      return editContent
    }
    if (isViewingHistoricalSnapshot) {
      return snapshotContent ?? memory?.content ?? ''
    }
    return memory?.content ?? ''
  }, [isEditingContent, editContent, isViewingHistoricalSnapshot, snapshotContent, memory?.content])

  const tocItems = useMemo(() => buildToc(tocSource), [tocSource])
  const headingPositions = useMemo(() => isEditingContent ? buildHeadingPositions(editContent) : [], [editContent, isEditingContent])
  const canShowToc = tocItems.length >= 2
  const showToc = isTocVisible && canShowToc

  // TOC tracking: edit mode — use editor top line + heading positions
  useEffect(() => {
    if (!showToc || !isEditingContent || contentMode !== 'edit' || headingPositions.length === 0) return
    if (Date.now() < tocClickActiveUntilRef.current) return
    let activeSlug = headingPositions[0].slug
    for (const h of headingPositions) {
      if (h.line <= editorTopLine) activeSlug = h.slug
      else break
    }
    setActiveHeadingId(activeSlug)
  }, [showToc, isEditingContent, contentMode, editorTopLine, headingPositions])

  // TOC tracking: view mode — use rendered heading elements in the DOM
  useEffect(() => {
    if (!showToc || isEditingContent || !contentRef.current) return

    const container = contentRef.current
    const headingElements = Array.from(
      container.querySelectorAll<HTMLElement>('h1, h2, h3')
    ).filter((el) => el.id)

    if (headingElements.length === 0) return

    let rafId = 0
    const topOffset = 24

    const containerRect = () => container.getBoundingClientRect()

    const updateActiveHeading = () => {
      if (Date.now() < tocClickActiveUntilRef.current) return
      const top = containerRect().top + topOffset
      let current = headingElements[0]
      for (const heading of headingElements) {
        if (heading.getBoundingClientRect().top <= top) {
          current = heading
        } else {
          break
        }
      }
      setActiveHeadingId(current.id)
    }

    const handleScroll = () => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(updateActiveHeading)
    }

    updateActiveHeading()
    container.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', handleScroll)

    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      container.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleScroll)
    }
  }, [showToc, isEditingContent, renderedContent, renderedEditContent])

  // Scroll to the heading the user was viewing after exiting edit mode
  useEffect(() => {
    if (isEditingContent || !pendingScrollSlugRef.current || !renderedContent) return
    const slug = pendingScrollSlugRef.current
    pendingScrollSlugRef.current = null
    requestAnimationFrame(() => {
      const container = contentRef.current
      const el = document.getElementById(slug)
      if (!el) return
      if (container && container.scrollHeight > container.clientHeight) {
        const containerTop = container.getBoundingClientRect().top
        const elTop = el.getBoundingClientRect().top
        container.scrollTop += elTop - containerTop
      } else {
        el.scrollIntoView({ block: 'start', behavior: 'instant' })
      }
    })
  }, [isEditingContent, renderedContent])

  const handleTocClick = useCallback((id: string) => {
    const container = contentRef.current
    if (!container) return

    // In edit mode with CodeEditor, scroll to the heading line via cursorTarget
    if (isEditingContent && contentMode === 'edit') {
      const heading = headingPositions.find((h) => h.slug === id)
      if (!heading) return
      tocClickActiveUntilRef.current = Date.now() + 1000
      setEditorCursorTarget({ line: heading.line, col: 1, token: Date.now() })
      setActiveHeadingId(id)
      return
    }

    const heading = container.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
    if (!heading) return
    tocClickActiveUntilRef.current = Date.now() + 1000
    heading.scrollIntoView({ block: 'start', behavior: 'smooth' })
    setActiveHeadingId(id)
  }, [isEditingContent, contentMode, headingPositions])

  return {
    renderedContent,
    renderedEditContent,
    globalDiagramTheme,
    activeHeadingId,
    setActiveHeadingId,
    isTocVisible,
    setIsTocVisible,
    editorTopLine,
    setEditorTopLine,
    editorCursorTarget,
    pendingScrollSlugRef,
    tocClickActiveUntilRef,
    tocItems,
    headingPositions,
    canShowToc,
    showToc,
    handleTocClick,
  }
}
