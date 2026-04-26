import { useState, useCallback, useRef } from 'preact/hooks'
import type { RefObject } from 'preact'
import { searchWithinMemory } from '../../lib/api'
import type { Memory, WithinMemorySearchResult } from '../../types'
import type { TocItem } from './lib'

interface UseContentSearchOptions {
  memory: Memory | null
  tocItems: TocItem[]
  contentRef: RefObject<HTMLDivElement>
  tocClickActiveUntilRef: { current: number }
  setActiveHeadingId: (id: string) => void
}

export function useContentSearch({
  memory,
  tocItems,
  contentRef,
  tocClickActiveUntilRef,
  setActiveHeadingId,
}: UseContentSearchOptions) {
  const [isContentSearchOpen, setIsContentSearchOpen] = useState(false)
  const [contentSearchQuery, setContentSearchQuery] = useState('')
  const [contentSearchResults, setContentSearchResults] = useState<WithinMemorySearchResult | null>(null)
  const [isContentSearching, setIsContentSearching] = useState(false)
  const contentSearchInputRef = useRef<HTMLInputElement>(null)

  const handleContentSearch = useCallback(async (query: string) => {
    if (!query.trim() || !memory) {
      setContentSearchResults(null)
      return
    }
    setIsContentSearching(true)
    try {
      const results = await searchWithinMemory(memory.id, query.trim())
      setContentSearchResults(results)
    } catch {
      setContentSearchResults(null)
    } finally {
      setIsContentSearching(false)
    }
  }, [memory])

  const handleContentSearchKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleContentSearch(contentSearchQuery)
    } else if (e.key === 'Escape') {
      setIsContentSearchOpen(false)
      setContentSearchQuery('')
      setContentSearchResults(null)
    }
  }, [contentSearchQuery, handleContentSearch])

  const openContentSearch = useCallback(() => {
    setIsContentSearchOpen(true)
    setTimeout(() => contentSearchInputRef.current?.focus(), 50)
  }, [])

  const closeContentSearch = useCallback(() => {
    setIsContentSearchOpen(false)
    setContentSearchQuery('')
    setContentSearchResults(null)
  }, [])

  const scrollToSearchResult = useCallback((sectionHeading: string) => {
    const container = contentRef.current
    if (!container) return
    // Match the search result heading to a TOC item to get the slug
    const tocMatch = tocItems.find((item) => item.text === sectionHeading)
    if (tocMatch) {
      const el = container.querySelector<HTMLElement>(`#${CSS.escape(tocMatch.id)}`)
      if (el) {
        tocClickActiveUntilRef.current = Date.now() + 1000
        el.scrollIntoView({ block: 'start', behavior: 'smooth' })
        setActiveHeadingId(tocMatch.id)
        return
      }
    }
    // Fallback: try case-insensitive match on heading text content
    const headings = container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')
    for (const h of headings) {
      if (h.textContent?.trim().toLowerCase() === sectionHeading.toLowerCase()) {
        h.scrollIntoView({ block: 'start', behavior: 'smooth' })
        return
      }
    }
  }, [tocItems, contentRef, tocClickActiveUntilRef, setActiveHeadingId])

  return {
    isContentSearchOpen,
    contentSearchQuery,
    contentSearchResults,
    isContentSearching,
    contentSearchInputRef,
    setContentSearchQuery,
    handleContentSearch,
    handleContentSearchKeyDown,
    openContentSearch,
    closeContentSearch,
    scrollToSearchResult,
  }
}
