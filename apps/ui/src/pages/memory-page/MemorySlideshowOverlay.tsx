import { useState, useEffect, useCallback } from 'preact/hooks'
import clsx from 'clsx'
import type { DiagramTheme } from '../../lib/exportPreferences'
import { MERMAID_WRAPPER_CLASS } from './lib'
import styles from '../MemoryPage.module.css'

interface Props {
  renderedContent: string
  navPosition: { current: number; total: number } | null
  onClose: () => void
  onDiagramClick: (svgHtml: string, theme: DiagramTheme | null) => void
}

export function MemorySlideshowOverlay({ renderedContent, navPosition, onClose, onDiagramClick }: Props) {
  const [slideshowHtml, setSlideshowHtml] = useState('')

  // Lock body scroll while slideshow is open
  useEffect(() => {
    const body = document.body
    const prevOverflow = body.style.overflow
    body.style.overflow = 'hidden'
    return () => {
      body.style.overflow = prevOverflow
    }
  }, [])

  // Sync rendered content into slideshow HTML
  useEffect(() => {
    if (renderedContent) {
      setSlideshowHtml(renderedContent)
    }
  }, [renderedContent])

  const handleContentClick = useCallback((event: MouseEvent) => {
    event.stopPropagation()
    let node = event.target as Element | null
    let diagram: HTMLElement | null = null
    while (node) {
      if (node instanceof HTMLElement && node.classList.contains(MERMAID_WRAPPER_CLASS)) {
        diagram = node
        break
      }
      node = node.parentElement
    }
    if (!diagram) return
    const svg = diagram.querySelector('svg')
    if (svg) {
      onDiagramClick(svg.outerHTML, diagram.getAttribute('data-theme') as DiagramTheme | null)
    }
  }, [onDiagramClick])

  return (
    <div class={styles.slideshowOverlay} onClick={onClose}>
      <div class={styles.slideshowSurface}>
        <div
          class={clsx(styles.slideshowContent, styles.contentMarkdown)}
          onClick={handleContentClick}
          dangerouslySetInnerHTML={{ __html: slideshowHtml || renderedContent }}
        />
      </div>
      {navPosition && (
        <div class={styles.slideshowCounter}>
          {navPosition.current}/{navPosition.total}
        </div>
      )}
    </div>
  )
}
