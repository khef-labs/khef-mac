import { useEffect, useRef } from 'preact/hooks'
import type { RefObject } from 'preact'

interface ShortcutDeps {
  // State flags
  isEditingContent: boolean
  isEditingMetadata: boolean
  isContentDirty: boolean
  isUploading: boolean
  isSlideshowOpen: boolean
  isContentSearchOpen: boolean
  isViewingHistoricalSnapshot: boolean
  diagramViewerSvg: string | null

  // Refs (passed through, not owned)
  contentSearchInputRef: RefObject<HTMLInputElement | null>
  fileInputRef: RefObject<HTMLInputElement | null>
  insertAsHtmlRef: { current: boolean }
  contentRef: RefObject<HTMLDivElement | null>
  inlineCommentOpenRef: { current: boolean }

  // Navigation
  navigatePrev: () => void
  navigateNext: () => void

  // Edit actions
  startEditingContent: () => void
  cancelEditingContent: () => void
  cancelEditingMetadata: () => void

  // Slideshow
  closeSlideshow: () => void

  // Content search
  openContentSearch: () => void

  // State setters
  setDiagramViewerSvg: (svg: string | null) => void
  setDiagramViewerTheme: (theme: null) => void
  setShowDiscardContentConfirm: (show: boolean) => void
  setShowSlideshowConfirm: (show: boolean) => void
  setFloatingButtonPos: (pos: { x: number; y: number } | null) => void
  setInlineCommentPos: (pos: { x: number; y: number } | null) => void
  setInlineCommentInput: (input: string) => void

  // Comments (subset of useComments return)
  comments: {
    captureSelection: () => void
    clearAnchor: () => void
  }

  // Cmd+S dispatch ref — MemoryPage assigns .current each render
  cmdSaveRef: { current: {
    save: (() => void) | null
    submitComment: () => void
    submitInlineComment: () => void
  }}
}

/**
 * Centralizes all window/document keyboard listeners for MemoryPage.
 *
 * Extracted effects:
 *  1. Diagram viewer keys (Esc, +/-, 0 zoom)
 *  2. Cmd+F content search toggle
 *  3. Arrow key prev/next navigation
 *  4. Main editing shortcuts (Esc, F slideshow, Cmd+E, Cmd+I, Cmd+Shift+I, Alt+C)
 *  5. Slideshow keys (arrows, Q)
 *  6. Cmd+S capture-phase listener
 */
export function useMemoryPageShortcuts(deps: ShortcutDeps) {
  // Keep a stable ref to the full deps so the capture-phase listener
  // (which uses [] deps) can always read the latest values.
  const depsRef = useRef(deps)
  depsRef.current = deps

  // 1. Diagram viewer keys
  useEffect(() => {
    if (!deps.diagramViewerSvg) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        deps.setDiagramViewerSvg(null)
        deps.setDiagramViewerTheme(null)
      }
      // +/-/0 zoom keys are handled inside MemoryDiagramViewer component
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [deps.diagramViewerSvg])

  // 2. Cmd+F to open content search (when not editing)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && !deps.isEditingContent) {
        e.preventDefault()
        if (deps.isContentSearchOpen) {
          deps.contentSearchInputRef.current?.focus()
        } else {
          deps.openContentSearch()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [deps.isEditingContent, deps.isContentSearchOpen, deps.openContentSearch])

  // 3. Arrow key navigation (when not editing, not in input/textarea)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return
      }
      if (deps.isEditingContent || deps.isEditingMetadata) return

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        deps.navigatePrev()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        deps.navigateNext()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [deps.navigatePrev, deps.navigateNext, deps.isEditingContent, deps.isEditingMetadata])

  // 4. Main editing shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Escape to cancel editing
      if (event.key === 'Escape') {
        if (deps.isEditingContent) {
          event.preventDefault()
          if (deps.isContentDirty) {
            deps.setShowDiscardContentConfirm(true)
          } else {
            deps.cancelEditingContent()
          }
        } else if (deps.isEditingMetadata) {
          event.preventDefault()
          deps.cancelEditingMetadata()
        }
        return
      }

      // F to open slideshow mode (when not editing)
      if (
        event.key.toLowerCase() === 'f' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !deps.isEditingContent &&
        !deps.isEditingMetadata &&
        !deps.isViewingHistoricalSnapshot
      ) {
        const target = event.target as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return
        }
        event.preventDefault()
        deps.setShowSlideshowConfirm(true)
        return
      }

      // Cmd+E / Ctrl+E to enter edit mode
      if ((event.metaKey || event.ctrlKey) && event.key === 'e') {
        if (deps.isEditingContent || deps.isEditingMetadata) return
        if (!deps.isViewingHistoricalSnapshot) {
          event.preventDefault()
          deps.startEditingContent()
        }
        return
      }

      // Cmd+S / Ctrl+S handled by capture-phase listener below

      // Cmd+Shift+I / Ctrl+Shift+I to upload and insert as HTML img tag
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'i') {
        if (deps.isEditingContent && !deps.isUploading) {
          event.preventDefault()
          deps.insertAsHtmlRef.current = true
          deps.fileInputRef.current?.click()
        }
        return
      }

      // Cmd+I / Ctrl+I — italic when textarea focused (handled by textarea onKeyDown),
      // image upload otherwise
      if ((event.metaKey || event.ctrlKey) && event.key === 'i') {
        const target = event.target as HTMLElement | null
        if (target?.tagName === 'TEXTAREA') return // let textarea handler do italic
        if (deps.isEditingContent && !deps.isUploading) {
          event.preventDefault()
          deps.insertAsHtmlRef.current = false
          deps.fileInputRef.current?.click()
        }
      }

      // Alt+C to capture anchor selection and open inline comment box
      if (event.altKey && event.code === 'KeyC' && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        const sel = window.getSelection()
        if (sel && !sel.isCollapsed && deps.contentRef.current?.contains(sel.anchorNode)) {
          const range = sel.getRangeAt(0)
          const rect = range.getBoundingClientRect()
          const containerRect = deps.contentRef.current.getBoundingClientRect()
          const pos = {
            x: rect.left - containerRect.left + rect.width / 2,
            y: rect.bottom - containerRect.top,
          }
          deps.comments.captureSelection()
          deps.setFloatingButtonPos(null)
          deps.setInlineCommentPos(pos)
          deps.inlineCommentOpenRef.current = true
          deps.setInlineCommentInput('')
          requestAnimationFrame(() => {
            const inlineTextarea = document.querySelector<HTMLTextAreaElement>('[data-inline-comment-input]')
            inlineTextarea?.focus()
          })
        } else {
          // No selection — focus the bottom comment input
          const commentTextarea = document.querySelector<HTMLTextAreaElement>('[data-comment-input]')
          commentTextarea?.focus()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    deps.isEditingContent, deps.isEditingMetadata, deps.isUploading,
    deps.isViewingHistoricalSnapshot, deps.startEditingContent,
    deps.cancelEditingContent, deps.cancelEditingMetadata,
    deps.comments.captureSelection, deps.isContentDirty,
    deps.isSlideshowOpen, deps.closeSlideshow,
  ])

  // 5. Slideshow keys (arrows + Q to quit)
  useEffect(() => {
    if (!deps.isSlideshowOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        deps.navigatePrev()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        deps.navigateNext()
      } else if (event.key.toLowerCase() === 'q') {
        event.preventDefault()
        deps.closeSlideshow()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [deps.isSlideshowOpen, deps.navigatePrev, deps.navigateNext, deps.closeSlideshow])

  // 6. Capture-phase listener: intercept Cmd+S before the browser Save Page dialog
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.code !== 'KeyS' && e.key?.toLowerCase() !== 's') return

      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()

      // If focused on a comment input, submit the comment
      const el = document.activeElement as HTMLElement | null
      if (el?.matches('[data-inline-comment-input]')) {
        deps.cmdSaveRef.current.submitInlineComment()
      } else if (el?.matches('[data-comment-input]')) {
        deps.cmdSaveRef.current.submitComment()
      } else {
        deps.cmdSaveRef.current.save?.()
      }
    }

    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, []) // empty deps — refs always have latest values
}
