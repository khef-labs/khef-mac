import { useState, useEffect, useRef } from 'preact/hooks'
import { Table2, Eye, ZoomIn, ZoomOut, Maximize2, Save, RefreshCw } from 'lucide-preact'
import panzoom from 'panzoom'
import clsx from 'clsx'
import type { DbxTableDetail, DbxQueryResult, DbxErdData } from '../../lib/dbx-api'
import { saveErd } from '../../lib/dbx-api'
import { previewDiagram } from '../../lib/api'
import type { DetailViewTab, PropsSubtab, Tab } from './types'
import { ResultGrid, pgArray } from './ResultGrid'
import styles from './DatabasePage.module.css'

function generateErdMermaid(data: DbxErdData): string {
  const lines: string[] = ['erDiagram']
  const focused = data.focused
  const focusedKey = focused.name

  // Helper: get PK columns for a table
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

  // Helper: render entity block
  function renderEntity(detail: DbxTableDetail) {
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

  // Render focused table
  renderEntity(focused)

  // Render related tables
  for (const [, detail] of Object.entries(data.related)) {
    renderEntity(detail)
  }

  // Outgoing FK relationships
  for (const fk of focused.foreign_keys) {
    const refTable = fk.referenced_table
    lines.push(`    ${focusedKey} }o--|| ${refTable} : "${pgArray(fk.columns).join(', ')}"`)
  }

  // Reverse FK relationships
  const reverseGrouped = new Map<string, string[]>()
  for (const rfk of data.reverse_fks) {
    const key = rfk.source_table
    if (!reverseGrouped.has(key)) reverseGrouped.set(key, [])
    reverseGrouped.get(key)!.push(rfk.source_column)
  }
  for (const [sourceTable, cols] of reverseGrouped) {
    lines.push(`    ${sourceTable} }o--|| ${focusedKey} : "${cols.join(', ')}"`)
  }

  return lines.join('\n')
}

interface TableDetailPanelProps {
  tab: DetailViewTab
  tableDetail: DbxTableDetail
  tableData: DbxQueryResult | null
  connectionName: string
  maxRows: number
  onMaxRowsChange: (n: number) => void
  resultViewMode: 'grid' | 'record'
  onResultViewModeChange: (mode: 'grid' | 'record') => void
  recordIndex: number
  onRecordIndexChange: (i: number) => void
  onUpdateTab: (updater: (tabs: Tab[]) => Tab[]) => void
  onLoadData: (tab: DetailViewTab, opts?: { sort?: string; order?: string; where?: string }) => void
  onLoadErd: (tab: DetailViewTab) => void
  onRefresh: () => void
  isRefreshing: boolean
  onOpenInSql: () => void
  onEditRow?: (rowIndex: number) => void
}

export function TableDetailPanel({
  tab, tableDetail, tableData, connectionName,
  maxRows, onMaxRowsChange,
  resultViewMode, onResultViewModeChange,
  recordIndex, onRecordIndexChange,
  onUpdateTab, onLoadData, onLoadErd, onRefresh, isRefreshing, onOpenInSql, onEditRow,
}: TableDetailPanelProps) {
  const [erdSvg, setErdSvg] = useState<string | null>(null)
  const [erdLoading, setErdLoading] = useState(false)
  const [erdError, setErdError] = useState<string | null>(null)
  const [erdSaving, setErdSaving] = useState(false)
  const [erdSaveResult, setErdSaveResult] = useState<string | null>(null)
  const erdMermaidRef = useRef<string>('')

  const erdContainerRef = useRef<HTMLDivElement>(null)
  const panzoomRef = useRef<ReturnType<typeof panzoom> | null>(null)

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

  // Render ERD SVG when erd data is available
  useEffect(() => {
    if (!tab.erdData) { setErdSvg(null); return }
    let active = true
    setErdLoading(true)
    setErdError(null)
    const mermaid = generateErdMermaid(tab.erdData)
    erdMermaidRef.current = mermaid
    previewDiagram('mermaid', mermaid, 'dark')
      .then(res => { if (active) setErdSvg(res.svg) })
      .catch(err => { if (active) setErdError(err.message || 'Failed to render ERD') })
      .finally(() => { if (active) setErdLoading(false) })
    return () => { active = false }
  }, [tab.erdData])

  const [dataFilter, setDataFilter] = useState('')
  const [filterError, setFilterError] = useState<string | null>(null)

  function applyFilter() {
    setFilterError(null)
    onLoadData(tab, { where: dataFilter.trim() || undefined })
  }

  function setDetailTab(dt: 'properties' | 'data' | 'diagram') {
    onUpdateTab(tabs => tabs.map(t => t.id === tab.id && t.kind === 'detail' ? { ...t, detailTab: dt } : t))
  }

  function setPropsSubtab(ps: PropsSubtab) {
    onUpdateTab(tabs => tabs.map(t => t.id === tab.id && t.kind === 'detail' ? { ...t, propsSubtab: ps } : t))
  }

  return (
    <div class={styles.detailView}>
      {/* Header */}
      <div class={styles.detailHeader}>
        {tableDetail.type === 'view'
          ? <Eye size={16} style={{ color: 'var(--warning)' }} />
          : <Table2 size={16} style={{ color: 'var(--success)' }} />}
        <span class={styles.detailTitle}>{tableDetail.name}</span>
        <div class={styles.detailMeta}>
          <span>OID: {tableDetail.oid}</span>
          {tableDetail.row_estimate >= 0 && <span>~{tableDetail.row_estimate} rows</span>}
          {tableDetail.size && <span>{tableDetail.size}</span>}
        </div>
        <div class={styles.spacer} />
        <button class={styles.btnIcon} onClick={onRefresh} disabled={isRefreshing} title="Refresh"><RefreshCw size={13} class={isRefreshing ? styles.spinning : ''} /></button>
        <button class={styles.btnAdd} onClick={onOpenInSql}>Open in SQL</button>
      </div>

      {/* Tabs */}
      <div class={styles.detailTabs}>
        <button class={clsx(styles.detailTab, tab.detailTab === 'properties' && styles.active)} onClick={() => setDetailTab('properties')}>Properties</button>
        <button class={clsx(styles.detailTab, tab.detailTab === 'data' && styles.active)} onClick={() => {
          setDetailTab('data')
          if (!tableData) onLoadData(tab)
        }}>Data</button>
        {tableDetail.type === 'table' && (
          <button class={clsx(styles.detailTab, tab.detailTab === 'diagram' && styles.active)} onClick={() => {
            setDetailTab('diagram')
            if (!tab.erdData) onLoadErd(tab)
          }}>Diagram</button>
        )}
      </div>

      {/* Properties */}
      {tab.detailTab === 'properties' && (
        <>
          <div class={styles.subtabs}>
            <button class={clsx(styles.subtab, tab.propsSubtab === 'columns' && styles.active)} onClick={() => setPropsSubtab('columns')}>Columns</button>
            {tableDetail.type === 'table' && (
              <>
                <button class={clsx(styles.subtab, tab.propsSubtab === 'constraints' && styles.active)} onClick={() => setPropsSubtab('constraints')}>Constraints</button>
                <button class={clsx(styles.subtab, tab.propsSubtab === 'fks' && styles.active)} onClick={() => setPropsSubtab('fks')}>Foreign Keys</button>
                <button class={clsx(styles.subtab, tab.propsSubtab === 'indexes' && styles.active)} onClick={() => setPropsSubtab('indexes')}>Indexes</button>
                <button class={clsx(styles.subtab, tab.propsSubtab === 'triggers' && styles.active)} onClick={() => setPropsSubtab('triggers')}>Triggers</button>
              </>
            )}
            {tableDetail.type === 'view' && (
              <>
                <button class={clsx(styles.subtab, tab.propsSubtab === 'definition' && styles.active)} onClick={() => setPropsSubtab('definition')}>Definition</button>
                <button class={clsx(styles.subtab, tab.propsSubtab === 'dependencies' && styles.active)} onClick={() => setPropsSubtab('dependencies')}>Dependencies</button>
              </>
            )}
          </div>

          <div class={styles.detailContent}>
            {tab.propsSubtab === 'columns' && (
              <table class={styles.dataGrid}>
                <thead><tr><th>#</th><th>Column Name</th><th>Data Type</th><th>Not Null</th><th>Default</th><th>Comment</th></tr></thead>
                <tbody>
                  {tableDetail.columns.map(col => (
                    <tr key={col.name}>
                      <td class={styles.cellNum}>{col.position}</td>
                      <td>{col.name}</td>
                      <td>{col.data_type}</td>
                      <td class={!col.is_nullable ? styles.cellBool : styles.cellNull}>{col.is_nullable ? 'NO' : 'YES'}</td>
                      <td class={styles.cellTs}>{col.column_default || ''}</td>
                      <td class={styles.cellTs}>{col.comment || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {tab.propsSubtab === 'constraints' && (
              <table class={styles.dataGrid}>
                <thead><tr><th>Name</th><th>Type</th><th>Columns</th><th>Expression</th></tr></thead>
                <tbody>
                  {tableDetail.constraints.map(c => (
                    <tr key={c.name}><td>{c.name}</td><td>{c.type}</td><td>{pgArray(c.columns).join(', ')}</td><td class={styles.cellTs}>{c.expression || ''}</td></tr>
                  ))}
                  {tableDetail.constraints.length === 0 && (
                    <tr><td colSpan={4} style={{ textAlign: 'center', padding: '24px', color: 'var(--muted)' }}>No constraints</td></tr>
                  )}
                </tbody>
              </table>
            )}

            {tab.propsSubtab === 'fks' && (
              <table class={styles.dataGrid}>
                <thead><tr><th>Name</th><th>Columns</th><th>References</th><th>On Update</th><th>On Delete</th></tr></thead>
                <tbody>
                  {tableDetail.foreign_keys.map(fk => (
                    <tr key={fk.name}>
                      <td>{fk.name}</td>
                      <td>{pgArray(fk.columns).join(', ')}</td>
                      <td>{fk.referenced_schema}.{fk.referenced_table}({pgArray(fk.referenced_columns).join(', ')})</td>
                      <td>{fk.on_update}</td>
                      <td>{fk.on_delete}</td>
                    </tr>
                  ))}
                  {tableDetail.foreign_keys.length === 0 && (
                    <tr><td colSpan={5} style={{ textAlign: 'center', padding: '24px', color: 'var(--muted)' }}>No foreign keys</td></tr>
                  )}
                </tbody>
              </table>
            )}

            {tab.propsSubtab === 'indexes' && (
              <table class={styles.dataGrid}>
                <thead><tr><th>Name</th><th>Columns</th><th>Unique</th><th>Type</th><th>Size</th></tr></thead>
                <tbody>
                  {tableDetail.indexes.map(idx => (
                    <tr key={idx.name}>
                      <td>{idx.name}</td>
                      <td>{idx.columns ? pgArray(idx.columns).join(', ') : ''}</td>
                      <td class={styles.cellBool}>{idx.is_unique ? 'YES' : 'NO'}</td>
                      <td>{idx.type}</td>
                      <td>{idx.size || ''}</td>
                    </tr>
                  ))}
                  {tableDetail.indexes.length === 0 && (
                    <tr><td colSpan={5} style={{ textAlign: 'center', padding: '24px', color: 'var(--muted)' }}>No indexes</td></tr>
                  )}
                </tbody>
              </table>
            )}

            {tab.propsSubtab === 'triggers' && (
              <table class={styles.dataGrid}>
                <thead><tr><th>Name</th><th>Timing</th><th>Event</th><th>Function</th></tr></thead>
                <tbody>
                  {tableDetail.triggers.map(trig => (
                    <tr key={trig.name}><td>{trig.name}</td><td>{trig.timing}</td><td>{trig.event}</td><td>{trig.function_name}</td></tr>
                  ))}
                  {tableDetail.triggers.length === 0 && (
                    <tr><td colSpan={4} style={{ textAlign: 'center', padding: '24px', color: 'var(--muted)' }}>No triggers</td></tr>
                  )}
                </tbody>
              </table>
            )}

            {tab.propsSubtab === 'definition' && tableDetail.definition && (
              <pre class={styles.viewDef}>{tableDetail.definition}</pre>
            )}

            {tab.propsSubtab === 'dependencies' && tableDetail.dependencies && (
              <table class={styles.dataGrid}>
                <thead><tr><th>Referenced Table</th></tr></thead>
                <tbody>
                  {tableDetail.dependencies.map(dep => (
                    <tr key={dep}><td>{dep}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* Data */}
      {tab.detailTab === 'data' && (
        <div class={styles.dataFilterBar}>
          <span class={styles.dataFilterLabel}>WHERE</span>
          <input
            class={styles.dataFilterInput}
            value={dataFilter}
            onInput={e => setDataFilter((e.target as HTMLInputElement).value)}
            onKeyDown={e => { if (e.key === 'Enter') applyFilter() }}
            placeholder="e.g. name LIKE '%test%' AND created_at > '2026-01-01'"
            spellcheck={false}
          />
          <button class={styles.btnAdd} onClick={applyFilter}>Apply</button>
          {dataFilter && <button class={styles.btnIcon} onClick={() => { setDataFilter(''); setFilterError(null); onLoadData(tab) }} title="Clear filter">✕</button>}
          {filterError && <span style={{ color: 'var(--error)', fontSize: '11px' }}>{filterError}</span>}
        </div>
      )}
      {tab.detailTab === 'data' && tableData && (
        <div class={styles.detailDataWrapper}>
          <ResultGrid
            result={tableData}
            queryError={null}
            maxRows={maxRows}
            onMaxRowsChange={onMaxRowsChange}
            viewMode={resultViewMode}
            onViewModeChange={onResultViewModeChange}
            recordIndex={recordIndex}
            onRecordIndexChange={onRecordIndexChange}
            onSort={(col, dir) => onLoadData(tab, { sort: col, order: dir, where: dataFilter.trim() || undefined })}
            onFilter={(where) => { setDataFilter(where); onLoadData(tab, { where }) }}
            onRowDoubleClick={tableDetail.type === 'table' && onEditRow ? onEditRow : undefined}
          />
        </div>
      )}
      {tab.detailTab === 'data' && !tableData && (
        <div class={styles.empty}>Loading data...</div>
      )}

      {/* Diagram */}
      {tab.detailTab === 'diagram' && (
        <div class={styles.erdWrapper}>
          {erdLoading && <div class={styles.empty}>Generating ERD...</div>}
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
                    const res = await saveErd({ connection_name: connectionName, schema: tableDetail.schema, table: tableDetail.name, mermaid: erdMermaidRef.current })
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
      )}
    </div>
  )
}
