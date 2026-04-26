import { useEffect, useRef } from 'preact/hooks'
import { ZoomIn, ZoomOut, Maximize2, ImageDown, X } from 'lucide-preact'
import panzoom from 'panzoom'
import type { DiagramTheme } from '../../lib/exportPreferences'
import styles from '../MemoryPage.module.css'

interface Props {
  svgHtml: string
  theme: DiagramTheme | null
  onClose: () => void
  onExportPng: (svg: string) => void
}

export function MemoryDiagramViewer({ svgHtml, theme, onClose, onExportPng }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const panzoomRef = useRef<ReturnType<typeof panzoom> | null>(null)

  // Keyboard zoom controls (+/-/0)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') {
        panzoomRef.current?.zoomAbs(0, 0, panzoomRef.current.getTransform().scale * 1.2)
      } else if (e.key === '-') {
        panzoomRef.current?.zoomAbs(0, 0, panzoomRef.current.getTransform().scale / 1.2)
      } else if (e.key === '0') {
        panzoomRef.current?.moveTo(0, 0)
        panzoomRef.current?.zoomAbs(0, 0, 1)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

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
  }, [svgHtml])

  return (
    <div
      class={styles.diagramViewerOverlay}
      data-theme={theme || undefined}
      onClick={onClose}
    >
      <div class={styles.diagramViewerControls}>
        <button
          class={styles.diagramViewerButton}
          onClick={(e) => {
            e.stopPropagation()
            panzoomRef.current?.zoomAbs(0, 0, panzoomRef.current.getTransform().scale * 1.3)
          }}
          title="Zoom in (+)"
        >
          <ZoomIn size={20} />
        </button>
        <button
          class={styles.diagramViewerButton}
          onClick={(e) => {
            e.stopPropagation()
            panzoomRef.current?.zoomAbs(0, 0, panzoomRef.current.getTransform().scale / 1.3)
          }}
          title="Zoom out (-)"
        >
          <ZoomOut size={20} />
        </button>
        <button
          class={styles.diagramViewerButton}
          onClick={(e) => {
            e.stopPropagation()
            panzoomRef.current?.moveTo(0, 0)
            panzoomRef.current?.zoomAbs(0, 0, 1)
          }}
          title="Reset (0)"
        >
          <Maximize2 size={20} />
        </button>
        <button
          class={styles.diagramViewerButton}
          onClick={(e) => {
            e.stopPropagation()
            onExportPng(svgHtml)
          }}
          title="Export as PNG"
        >
          <ImageDown size={20} />
        </button>
        <button
          class={styles.diagramViewerButton}
          onClick={onClose}
          title="Close (Esc)"
        >
          <X size={20} />
        </button>
      </div>
      <div
        class={styles.diagramViewerContainer}
        ref={containerRef}
        onClick={(e) => e.stopPropagation()}
        dangerouslySetInnerHTML={{ __html: svgHtml }}
      />
    </div>
  )
}
