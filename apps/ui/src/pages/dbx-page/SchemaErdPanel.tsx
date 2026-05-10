import { useState, useEffect, useRef } from 'preact/hooks'
import { ZoomIn, ZoomOut, Maximize2, Save } from 'lucide-preact'
import panzoom from 'panzoom'
import type { DbxSchemaErdData, DbxTableDetail } from '../../lib/dbx-api'
import { saveErd } from '../../lib/dbx-api'
import { previewDiagram } from '../../lib/api'
import type { SchemaErdTab } from './types'
import { pgArray } from './ResultGrid'
import styles from './DbxPage.module.css'

function generateSchemaErd(data: DbxSchemaErdData): string {
  const lines: string[] = ['erDiagram']

  function pkCols(detail: DbxTableDetail): Set<string> {
    const pks = new Set<string>()
    for (const c of detail.constraints) {
      if (c.type === 'PRIMARY KEY') {
        for (const col of (Array.isArray(c.columns) ? c.columns : pgArray(c.columns))) {
          pks.add(col)
        }
      }
    }
    return pks
  }

  // Render all tables
  for (const [, detail] of Object.entries(data.tables)) {
    const pks = pkCols(detail)
    const fkCols = new Set<string>()
    for (const fk of detail.foreign_keys) {
      for (const col of (Array.isArray(fk.columns) ? fk.columns : pgArray(fk.columns))) {
        fkCols.add(col)
      }
    }
    lines.push(`    ${detail.name} {`)
    for (const col of detail.columns) {
      const annotation = pks.has(col.name) ? ' PK' : fkCols.has(col.name) ? ' FK' : ''
      const safeType = col.data_type.replace(/\s+/g, '_')
      lines.push(`        ${safeType} ${col.name}${annotation}`)
    }
    lines.push('    }')
  }

  // Render all FK relationships (only within this schema's tables)
  const tableNames = new Set(Object.keys(data.tables))
  for (const [, detail] of Object.entries(data.tables)) {
    for (const fk of detail.foreign_keys) {
      if (tableNames.has(fk.referenced_table)) {
        lines.push(`    ${detail.name} }o--|| ${fk.referenced_table} : "${pgArray(fk.columns).join(', ')}"`)
      }
    }
  }

  return lines.join('\n')
}

interface Props {
  tab: SchemaErdTab
  connectionName: string
}

export function SchemaErdPanel({ tab, connectionName }: Props) {
  const [erdSvg, setErdSvg] = useState<string | null>(null)
  const [erdLoading, setErdLoading] = useState(false)
  const [erdError, setErdError] = useState<string | null>(null)
  const [erdSaving, setErdSaving] = useState(false)
  const [erdSaveResult, setErdSaveResult] = useState<string | null>(null)
  const erdContainerRef = useRef<HTMLDivElement>(null)
  const panzoomRef = useRef<ReturnType<typeof panzoom> | null>(null)
  const erdMermaidRef = useRef<string>('')

  useEffect(() => {
    if (!erdContainerRef.current || !erdSvg) return
    const instance = panzoom(erdContainerRef.current, {
      maxZoom: 10,
      minZoom: 0.1,
      smoothScroll: false,
      zoomDoubleClickSpeed: 1,
    })
    panzoomRef.current = instance
    return () => { instance.dispose(); panzoomRef.current = null }
  }, [erdSvg])

  useEffect(() => {
    if (!tab.erdData) { setErdSvg(null); return }
    let active = true
    setErdLoading(true)
    setErdError(null)
    const mermaid = generateSchemaErd(tab.erdData)
    erdMermaidRef.current = mermaid
    previewDiagram('mermaid', mermaid, 'dark')
      .then(res => { if (active) setErdSvg(res.svg) })
      .catch(err => { if (active) setErdError(err.message || 'Failed to render ERD') })
      .finally(() => { if (active) setErdLoading(false) })
    return () => { active = false }
  }, [tab.erdData])

  return (
    <div class={styles.erdWrapper} style={{ flex: 1 }}>
      {erdLoading && <div class={styles.empty}>Generating schema ERD ({tab.erdData?.table_count ?? '...'} tables)...</div>}
      {erdError && <div class={styles.empty} style={{ color: 'var(--error)' }}>{erdError}</div>}
      {erdSvg && (
        <>
          <div class={styles.erdControls}>
            <button class={styles.erdControlBtn} onClick={() => panzoomRef.current?.zoomAbs(0, 0, (panzoomRef.current?.getTransform().scale ?? 1) * 1.3)} title="Zoom in"><ZoomIn size={14} /></button>
            <button class={styles.erdControlBtn} onClick={() => panzoomRef.current?.zoomAbs(0, 0, (panzoomRef.current?.getTransform().scale ?? 1) / 1.3)} title="Zoom out"><ZoomOut size={14} /></button>
            <button class={styles.erdControlBtn} onClick={() => {
              const pz = panzoomRef.current
              const svg = erdContainerRef.current?.querySelector('svg')
              const viewport = erdContainerRef.current?.parentElement
              if (!pz || !svg || !viewport) { pz?.moveTo(0, 0); pz?.zoomAbs(0, 0, 1); return }
              const svgW = svg.viewBox?.baseVal?.width || svg.getBBox().width
              const svgH = svg.viewBox?.baseVal?.height || svg.getBBox().height
              const vw = viewport.clientWidth
              const vh = viewport.clientHeight
              const scale = Math.min(vw / svgW, vh / svgH, 1) * 0.9
              pz.zoomAbs(0, 0, scale)
              pz.moveTo((vw - svgW * scale) / 2, (vh - svgH * scale) / 2)
            }} title="Fit to view"><Maximize2 size={14} /></button>
            <button class={styles.erdControlBtn} disabled={erdSaving} onClick={async () => {
              if (!erdMermaidRef.current) return
              setErdSaving(true)
              setErdSaveResult(null)
              try {
                const res = await saveErd({ connection_name: connectionName, schema: tab.schema, mermaid: erdMermaidRef.current })
                setErdSaveResult(res.created ? 'Saved' : 'Updated')
                if (res.url) window.open(res.url, '_blank')
                setTimeout(() => setErdSaveResult(null), 3000)
              } catch (err: any) { setErdSaveResult('Error: ' + (err.message || 'failed')) }
              finally { setErdSaving(false) }
            }} title="Save to Khef"><Save size={14} /></button>
            {erdSaveResult && <span style={{ fontSize: '11px', color: 'var(--success)', padding: '0 6px' }}>{erdSaveResult}</span>}
          </div>
          <div class={styles.erdViewport}>
            <div ref={erdContainerRef} class={styles.erdSvg} dangerouslySetInnerHTML={{ __html: erdSvg }} />
          </div>
        </>
      )}
      {!erdLoading && !erdError && !erdSvg && !tab.erdData && (
        <div class={styles.empty}>Loading ERD data...</div>
      )}
    </div>
  )
}
