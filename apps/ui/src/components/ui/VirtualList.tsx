import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'preact/hooks'
import type { ComponentChildren } from 'preact'

interface VirtualRowProps {
  index: number
  onMeasure: (index: number, height: number) => void
  children: ComponentChildren
}

export interface VirtualListProps<T> {
  items: T[]
  /** Scroll container ref. If the element isn't scrollable, walks up to find the nearest scrollable ancestor. */
  containerRef: { current: HTMLElement | null }
  estimateHeight: number
  identity: unknown
  overscan?: number
  renderItem: (item: T, index: number) => ComponentChildren
}

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el
  while (node && node !== document.documentElement) {
    const style = getComputedStyle(node)
    if (/(auto|scroll)/.test(style.overflowY)) return node
    node = node.parentElement
  }
  return document.documentElement
}

function VirtualRow({ index, onMeasure, children }: VirtualRowProps) {
  const rowRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const node = rowRef.current
    if (!node) return

    const measure = () => onMeasure(index, node.offsetHeight)
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [index, onMeasure, children])

  return <div ref={rowRef}>{children}</div>
}

export function VirtualList<T>({
  items,
  containerRef,
  estimateHeight,
  identity,
  overscan = 6,
  renderItem,
}: VirtualListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [listOffset, setListOffset] = useState(0)
  const [sizeVersion, setSizeVersion] = useState(0)
  const sizesRef = useRef<Map<number, number>>(new Map())
  const scrollParentRef = useRef<HTMLElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    sizesRef.current = new Map()
    setSizeVersion(v => v + 1)
  }, [identity])

  // Resolve the actual scroll container and measure offset
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const scrollParent = findScrollParent(el)
    scrollParentRef.current = scrollParent
    if (!scrollParent) return

    const sync = () => {
      setScrollTop(scrollParent.scrollTop)
      setViewportHeight(scrollParent.clientHeight)
    }

    sync()
    scrollParent.addEventListener('scroll', sync, { passive: true })
    const observer = new ResizeObserver(sync)
    observer.observe(scrollParent)

    return () => {
      scrollParent.removeEventListener('scroll', sync)
      observer.disconnect()
    }
  }, [containerRef, identity])

  // Track the list's offset within the scroll container
  useEffect(() => {
    const sentinel = sentinelRef.current
    const scrollParent = scrollParentRef.current
    if (!sentinel || !scrollParent) return

    const measure = () => {
      const parentRect = scrollParent.getBoundingClientRect()
      const sentinelRect = sentinel.getBoundingClientRect()
      setListOffset(sentinelRect.top - parentRect.top + scrollParent.scrollTop)
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [identity])

  const getSize = useCallback((index: number) => {
    return sizesRef.current.get(index) ?? estimateHeight
  }, [estimateHeight])

  const handleMeasure = useCallback((index: number, height: number) => {
    if (!height) return
    const prev = sizesRef.current.get(index)
    if (prev === height) return
    sizesRef.current.set(index, height)
    setSizeVersion(v => v + 1)
  }, [])

  const windowed = useMemo(() => {
    const effectiveViewportHeight = viewportHeight || 800
    // Adjust scrollTop relative to where the list starts
    const relativeScrollTop = Math.max(0, scrollTop - listOffset)
    const targetBottom = relativeScrollTop + effectiveViewportHeight

    let start = 0
    let offset = 0
    while (start < items.length) {
      const nextOffset = offset + getSize(start)
      if (nextOffset > relativeScrollTop) break
      offset = nextOffset
      start += 1
    }

    start = Math.max(0, start - overscan)

    let topSpacer = 0
    for (let i = 0; i < start; i += 1) topSpacer += getSize(i)

    let end = start
    let visibleHeight = 0
    while (end < items.length && topSpacer + visibleHeight < targetBottom + overscan * estimateHeight) {
      visibleHeight += getSize(end)
      end += 1
    }

    end = Math.min(items.length, end + overscan)

    let totalHeight = 0
    for (let i = 0; i < items.length; i += 1) totalHeight += getSize(i)

    let renderedHeight = 0
    for (let i = start; i < end; i += 1) renderedHeight += getSize(i)

    return {
      start,
      end,
      topSpacer,
      bottomSpacer: Math.max(0, totalHeight - topSpacer - renderedHeight),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateHeight, getSize, items, listOffset, overscan, scrollTop, sizeVersion, viewportHeight])

  return (
    <>
      <div ref={sentinelRef} style={{ height: 0 }} />
      {windowed.topSpacer > 0 && <div style={{ height: `${windowed.topSpacer}px` }} />}
      {items.slice(windowed.start, windowed.end).map((item, visibleIdx) => {
        const index = windowed.start + visibleIdx
        return (
          <VirtualRow key={index} index={index} onMeasure={handleMeasure}>
            {renderItem(item, index)}
          </VirtualRow>
        )
      })}
      {windowed.bottomSpacer > 0 && <div style={{ height: `${windowed.bottomSpacer}px` }} />}
    </>
  )
}
